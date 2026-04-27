import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSeatingChatSnapshot,
  detectSeatingMutationIntent,
  normalizeChatOperations,
  resolveEmptyMutationResponse,
} from '../gateway/services/seating-chat.js';

const students = [
  { id: 's01', name: '张三', gender: 'M' },
  { id: 's02', name: '李四', gender: 'F' },
  { id: 's03', name: '王五', gender: 'M' },
];

test('detectSeatingMutationIntent recognizes commands that should change seats', () => {
  assert.equal(detectSeatingMutationIntent('把张三和李四换一下'), true);
  assert.equal(detectSeatingMutationIntent('王五往前挪一排'), true);
  assert.equal(detectSeatingMutationIntent('分析一下有没有问题'), false);
});

test('normalizeChatOperations keeps id-first operations and accepts names as fallback', () => {
  const result = normalizeChatOperations([
    { type: 'swap', student1Id: 's01', student2: '李四' },
    { type: 'move', student: '王五', row: 0, col: 2 },
  ], students);

  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.operations, [
    { type: 'swap', student1Id: 's01', student1: '张三', student2Id: 's02', student2: '李四' },
    { type: 'move', studentId: 's03', student: '王五', row: 0, col: 2 },
  ]);
});

test('resolveEmptyMutationResponse marks empty operations as actionable failure for mutating commands', () => {
  const result = resolveEmptyMutationResponse({
    message: '把张三往前挪',
    operations: [],
    rejected: [],
  });

  assert.equal(result.mutationIntent, true);
  assert.equal(result.needsAction, true);
  assert.match(result.rejected[0].reason, /没有返回可执行/);
});

test('buildSeatingChatSnapshot includes id, name, and coordinates for each occupied seat', () => {
  const snapshot = buildSeatingChatSnapshot({
    layout: [
      ['s01', null],
      ['s02', 's03'],
    ],
    students,
  });

  assert.deepEqual(snapshot.occupied, [
    { id: 's01', name: '张三', row: 0, col: 0 },
    { id: 's02', name: '李四', row: 1, col: 0 },
    { id: 's03', name: '王五', row: 1, col: 1 },
  ]);
});
