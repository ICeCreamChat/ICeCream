import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySeatingOperations,
  evaluateSeatingConstraints,
  parseFallbackSeatingOperations,
  validateLayoutIntegrity,
} from '../public/js/tools/seating-core.js';

const students = [
  { id: 's01', name: '张三', gender: 'M', grade: 91, height: 142 },
  { id: 's02', name: '李四', gender: 'F', grade: 80, height: 150 },
  { id: 's03', name: '王五', gender: 'M', grade: 76, height: 156 },
  { id: 's04', name: '赵六', gender: 'F', grade: 88, height: 160 },
];

test('applySeatingOperations swaps students by id and name without losing anyone', () => {
  const layout = [
    ['s01', 's02', null],
    ['s03', null, 's04'],
  ];

  const result = applySeatingOperations({
    layout,
    students,
    operations: [{ type: 'swap', student1Id: 's01', student2: '王五' }],
    rows: 2,
    cols: 3,
  });

  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.layout, [
    ['s03', 's02', null],
    ['s01', null, 's04'],
  ]);
  assert.equal(result.integrity.ok, true);
  assert.deepEqual(layout, [
    ['s01', 's02', null],
    ['s03', null, 's04'],
  ]);
});

test('applySeatingOperations moves to empty seats and swaps with occupied seats', () => {
  const layout = [
    ['s01', 's02', null],
    ['s03', null, 's04'],
  ];

  const result = applySeatingOperations({
    layout,
    students,
    operations: [
      { type: 'move', student: '李四', row: 1, col: 1 },
      { type: 'move', studentId: 's01', row: 1, col: 2 },
    ],
    rows: 2,
    cols: 3,
  });

  assert.equal(result.applied.length, 2);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.layout, [
    ['s04', null, null],
    ['s03', 's02', 's01'],
  ]);
  assert.equal(result.integrity.ok, true);
});

test('applySeatingOperations rejects unsafe operations and preserves layout integrity', () => {
  const layout = [
    ['s01', 's02', null],
    ['s03', null, 's04'],
  ];

  const result = applySeatingOperations({
    layout,
    students,
    operations: [
      { type: 'move', student: '张三', row: 0, col: 1 },
      { type: 'move', student: '不存在', row: 0, col: 2 },
      { type: 'move', student: '赵六', row: 9, col: 0 },
    ],
    rows: 2,
    cols: 3,
    colAisles: [1],
  });

  assert.equal(result.applied.length, 0);
  assert.equal(result.rejected.length, 3);
  assert.match(result.rejected[0].reason, /过道/);
  assert.match(result.rejected[1].reason, /未找到/);
  assert.match(result.rejected[2].reason, /超出/);
  assert.deepEqual(result.layout, layout);
  assert.equal(result.integrity.ok, true);
});

test('applySeatingOperations rejects custom blocked layout cells', () => {
  const layout = [
    ['s01', null, 's02'],
    ['s03', null, 's04'],
  ];

  const result = applySeatingOperations({
    layout,
    students,
    operations: [{ type: 'move', student: '张三', row: 0, col: 1 }],
    rows: 2,
    cols: 3,
    blockedCells: [{ r: 0, c: 1 }],
  });

  assert.equal(result.applied.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /过道/);
  assert.deepEqual(result.layout, layout);
});

test('validateLayoutIntegrity reports duplicates and missing placed students', () => {
  const result = validateLayoutIntegrity({
    layout: [
      ['s01', 's01', null],
      ['s03', null, null],
    ],
    students,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.duplicates, ['s01']);
  assert.deepEqual(result.missingPlacedIds.sort(), ['s02', 's04']);
});

test('evaluateSeatingConstraints recalculates front, back, avoid, pair, and prefer constraints', () => {
  const layout = [
    ['s01', 's02', 's03'],
    [null, null, null],
    ['s04', null, null],
  ];

  const result = evaluateSeatingConstraints({
    layout,
    students,
    rows: 3,
    cols: 3,
    constraints: [
      { type: 'front_row', target: '张三', reason: '视力不好', priority: 'hard' },
      { type: 'back_row', target: '赵六', reason: '个子高', priority: 'hard' },
      { type: 'avoid', target: '张三', related: '李四', reason: '爱讲话', priority: 'hard' },
      { type: 'pair', target: '李四', related: '王五', reason: '互助', priority: 'hard' },
      { type: 'prefer', target: '王五', related: '赵六', reason: '心愿', priority: 'soft' },
    ],
  });

  assert.equal(result.total, 5);
  assert.equal(result.satisfied, 3);
  assert.deepEqual(result.unsatisfied.map(c => c.type), ['avoid', 'prefer']);
  assert.equal(result.hardUnsatisfied.length, 1);
  assert.equal(result.softUnsatisfied.length, 1);
});

test('parseFallbackSeatingOperations parses common natural-language swap and move commands', () => {
  const layout = [
    ['s01', 's02', null],
    ['s03', null, 's04'],
  ];

  assert.deepEqual(
    parseFallbackSeatingOperations({
      message: '把张三和王五换一下',
      layout,
      students,
      rows: 2,
      cols: 3,
    }).operations,
    [{ type: 'swap', student1Id: 's01', student2Id: 's03' }]
  );

  assert.deepEqual(
    parseFallbackSeatingOperations({
      message: '把李四移到第2排第2列',
      layout,
      students,
      rows: 2,
      cols: 3,
    }).operations,
    [{ type: 'move', studentId: 's02', row: 1, col: 1 }]
  );
});

test('parseFallbackSeatingOperations parses directional movement and reports mutation intent', () => {
  const layout = [
    ['s01', 's02', null],
    ['s03', null, 's04'],
  ];

  const parsed = parseFallbackSeatingOperations({
    message: '赵六往左挪一位',
    layout,
    students,
    rows: 2,
    cols: 3,
  });

  assert.equal(parsed.mutationIntent, true);
  assert.deepEqual(parsed.operations, [{ type: 'move', studentId: 's04', row: 1, col: 1 }]);
  assert.deepEqual(parsed.rejected, []);
});

test('parseFallbackSeatingOperations does not invent operations for ambiguous commands', () => {
  const parsed = parseFallbackSeatingOperations({
    message: '帮我把某个同学往前挪',
    layout: [['s01']],
    students,
    rows: 1,
    cols: 1,
  });

  assert.equal(parsed.mutationIntent, true);
  assert.deepEqual(parsed.operations, []);
  assert.match(parsed.rejected[0].reason, /无法确定学生/);
});
