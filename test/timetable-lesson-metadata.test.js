import assert from 'node:assert/strict';
import test from 'node:test';

import {
    normalizeTimetableActivityTypes,
    normalizeTimetableResourceTypes,
    timetableActivityTypeKey,
    timetableResourceTypeKey,
    TIMETABLE_ACTIVITY_TYPE_OPTIONS,
    TIMETABLE_RESOURCE_TYPE_OPTIONS,
} from '../shared/timetable/lesson-metadata.js';

test('timetable lesson metadata exposes the supported activity and resource options', () => {
    assert.deepEqual(
        TIMETABLE_ACTIVITY_TYPE_OPTIONS.map(option => option.value),
        ['普通课', '实验课', '上机课', '新授课', '复习', '答疑', '社团'],
    );
    assert.deepEqual(
        TIMETABLE_RESOURCE_TYPE_OPTIONS.map(option => option.value),
        ['普通教室', '实验室', '计算机教室'],
    );
});

test('timetable lesson metadata normalizes known aliases and preserves unknown school values', () => {
    assert.deepEqual(
        normalizeTimetableActivityTypes(['普通', '实验课程', '上机', '新授', '复习课', 'QANDA', 'club', '校本研修课']),
        ['普通课', '实验课', '上机课', '新授课', '复习', '答疑', '社团', '校本研修课'],
    );
    assert.deepEqual(
        normalizeTimetableResourceTypes('ordinary、物理实验室、机房、创客空间'),
        ['普通教室', '实验室', '计算机教室', '创客空间'],
    );
    assert.deepEqual(
        normalizeTimetableResourceTypes('ordinary classroom、Maker Space'),
        ['普通教室', 'Maker Space'],
    );
    assert.equal(timetableActivityTypeKey('experiment'), timetableActivityTypeKey('实验课'));
    assert.equal(timetableActivityTypeKey('tutorial'), timetableActivityTypeKey('答疑'));
    assert.equal(timetableResourceTypeKey('ordinary'), timetableResourceTypeKey('普通教室'));
    assert.equal(timetableResourceTypeKey('lab'), timetableResourceTypeKey('化学实验室'));
    assert.equal(timetableResourceTypeKey('computer_room'), timetableResourceTypeKey('机房'));
    assert.equal(timetableResourceTypeKey('computer room'), timetableResourceTypeKey('计算机教室'));
});
