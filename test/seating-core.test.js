import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySeatingOperations,
  deleteAisleColumn,
  deleteAisleRow,
  evaluateSeatingConstraints,
  evaluateSeatingQuality,
  deleteLocalAisle,
  hasLocalAisle,
  insertAisleColumn,
  insertAisleRow,
  insertLocalAisle,
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

test('applySeatingOperations assigns students to guardian seats without duplicating them', () => {
  const layout = [
    ['s01', 's02', null],
    ['s03', null, 's04'],
  ];

  const result = applySeatingOperations({
    layout,
    students,
    guardians: ['s03', null],
    operations: [
      { type: 'set_guardian', student: '张三', side: 'left' },
      { type: 'set_guardian', studentId: 's04', side: 'right' },
    ],
    rows: 2,
    cols: 3,
  });

  assert.equal(result.applied.length, 2);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.guardians, ['s01', 's04']);
  assert.deepEqual(result.layout, [
    ['s03', 's02', null],
    [null, null, null],
  ]);
  assert.equal(result.integrity.ok, true);
});

test('applySeatingOperations assigns unplaced student directly as guardian', () => {
  // s05 is in students list but NOT in the layout grid
  const studentsWithExtra = [
    ...students,
    { id: 's05', name: '周五', gender: 'M', grade: 95, height: 158 },
  ];
  const layout = [
    ['s01', 's02', 's03'],
    [null, null, 's04'],
  ];

  const result = applySeatingOperations({
    layout,
    students: studentsWithExtra,
    guardians: [null, null],
    operations: [
      { type: 'set_guardian', student: '周五', side: 'left' },
    ],
    rows: 2,
    cols: 3,
  });

  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.rejected, []);
  // Unplaced s05 should become left guardian
  assert.deepEqual(result.guardians, ['s05', null]);
  // Layout should be unchanged (s05 wasn't in it)
  assert.deepEqual(result.layout, [
    ['s01', 's02', 's03'],
    [null, null, 's04'],
  ]);
  assert.equal(result.integrity.ok, true);
});

test('applySeatingOperations set_guardian noop does not count as applied', () => {
  const layout = [
    ['s01', 's02', null],
    ['s03', null, 's04'],
  ];

  // s04 is already right guardian
  const result = applySeatingOperations({
    layout,
    students,
    guardians: [null, 's04'],
    operations: [
      { type: 'set_guardian', student: '赵六', side: 'right' },
    ],
    rows: 2,
    cols: 3,
  });

  // Noop should NOT be in applied array
  assert.equal(result.applied.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /已经是右护法/);
  assert.deepEqual(result.guardians, [null, 's04']);
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

test('insertAisleRow shifts students down without losing placed IDs', () => {
  const result = insertAisleRow({
    layout: [
      ['s01', 's02'],
      ['s03', null],
    ],
    classroomLayout: {
      rows: 2,
      cols: 2,
      cells: [['seat', 'seat'], ['seat', 'seat']],
      groups: [[1, 1], [2, 2]],
      template: 'custom',
      groupSize: 2,
    },
    index: 1,
  });

  assert.deepEqual(result.layout, [
    ['s01', 's02'],
    [null, null],
    ['s03', null],
  ]);
  assert.deepEqual(result.classroomLayout.cells, [
    ['seat', 'seat'],
    ['aisle', 'aisle'],
    ['seat', 'seat'],
  ]);
  assert.deepEqual(result.rowAisles, [1]);
  assert.deepEqual(getPlaced(result.layout), ['s01', 's02', 's03']);
});

test('insertAisleColumn shifts students right without losing placed IDs', () => {
  const result = insertAisleColumn({
    layout: [
      ['s01', 's02'],
      ['s03', null],
    ],
    classroomLayout: {
      rows: 2,
      cols: 2,
      cells: [['seat', 'seat'], ['seat', 'seat']],
      groups: [[1, 1], [2, 2]],
      template: 'custom',
      groupSize: 2,
    },
    index: 1,
  });

  assert.deepEqual(result.layout, [
    ['s01', null, 's02'],
    ['s03', null, null],
  ]);
  assert.deepEqual(result.classroomLayout.cells, [
    ['seat', 'aisle', 'seat'],
    ['seat', 'aisle', 'seat'],
  ]);
  assert.deepEqual(result.colAisles, [1]);
  assert.deepEqual(getPlaced(result.layout), ['s01', 's02', 's03']);
});

test('deleteAisleRow and deleteAisleColumn compact layouts back safely', () => {
  const rowDeleted = deleteAisleRow({
    layout: [
      ['s01', 's02'],
      [null, null],
      ['s03', null],
    ],
    classroomLayout: {
      rows: 3,
      cols: 2,
      cells: [['seat', 'seat'], ['aisle', 'aisle'], ['seat', 'seat']],
      groups: [[1, 1], [null, null], [2, 2]],
      template: 'custom',
      groupSize: 2,
    },
    index: 1,
  });
  assert.deepEqual(rowDeleted.layout, [
    ['s01', 's02'],
    ['s03', null],
  ]);
  assert.deepEqual(rowDeleted.rowAisles, []);

  const colDeleted = deleteAisleColumn({
    layout: [
      ['s01', null, 's02'],
      ['s03', null, null],
    ],
    classroomLayout: {
      rows: 2,
      cols: 3,
      cells: [['seat', 'aisle', 'seat'], ['seat', 'aisle', 'seat']],
      groups: [[1, null, 2], [3, null, 4]],
      template: 'custom',
      groupSize: 1,
    },
    index: 1,
  });
  assert.deepEqual(colDeleted.layout, [
    ['s01', 's02'],
    ['s03', null],
  ]);
  assert.deepEqual(colDeleted.colAisles, []);
});

test('local aisle helpers only toggle the boundary between two seats', () => {
  const classroomLayout = {
    rows: 2,
    cols: 2,
    cells: [['seat', 'seat'], ['seat', 'seat']],
    groups: [[1, 1], [2, 2]],
    template: 'custom',
    groupSize: 2,
  };

  const inserted = insertLocalAisle({
    classroomLayout,
    orientation: 'vertical',
    row: 0,
    col: 0,
  });

  assert.deepEqual(inserted.cells, classroomLayout.cells);
  assert.equal(inserted.rows, 2);
  assert.equal(inserted.cols, 2);
  assert.deepEqual(inserted.localAisles, {
    vertical: [{ row: 0, col: 0 }],
    horizontal: [],
  });
  assert.equal(hasLocalAisle(inserted.localAisles, 'vertical', 0, 0), true);

  const removed = deleteLocalAisle({
    classroomLayout: inserted,
    orientation: 'vertical',
    row: 0,
    col: 0,
  });

  assert.deepEqual(removed.localAisles, { vertical: [], horizontal: [] });
  assert.deepEqual(classroomLayout.localAisles, undefined);
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

function getPlaced(layout) {
  return layout.flat().filter(Boolean).sort();
}

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

test('evaluateSeatingConstraints understands rich row, relative, and grade-neighbor needs', () => {
  const localStudents = [
    { id: 'a', name: '前排学生', grade: 95 },
    { id: 'b', name: '最后学生', grade: 40 },
    { id: 'c', name: '后方学生', grade: 80 },
    { id: 'd', name: '参照学生', grade: 70 },
    { id: 'e', name: '需强邻', grade: 60 },
    { id: 'f', name: '低分邻座', grade: 45 },
    { id: 'g', name: '普通同学', grade: 55 },
  ];
  const layout = [
    ['a', null, null, null],
    ['d', null, 'g', null],
    ['c', null, 'e', 'f'],
    [null, null, null, 'b'],
  ];

  const result = evaluateSeatingConstraints({
    layout,
    students: localStudents,
    rows: 4,
    cols: 4,
    constraints: [
      { type: 'avoid_first_row', target: '前排学生', priority: 'hard' },
      { type: 'avoid_last_row', target: '最后学生', priority: 'hard' },
      { type: 'avoid_behind', target: '后方学生', related: '参照学生', priority: 'hard' },
      { type: 'prefer_high_grade_neighbor', target: '需强邻', priority: 'soft' },
      { type: 'avoid_low_grade_deskmate', target: '低分邻座', priority: 'hard' },
    ],
  });

  assert.deepEqual(result.unsatisfied.map(item => item.type), [
    'avoid_first_row',
    'avoid_last_row',
    'avoid_behind',
    'prefer_high_grade_neighbor',
    'avoid_low_grade_deskmate',
  ]);
  assert.equal(result.hardUnsatisfied.length, 4);
  assert.equal(result.softUnsatisfied.length, 1);
});

test('evaluateSeatingQuality reports hard layout problems and caps invalid scores', () => {
  const result = evaluateSeatingQuality({
    layout: [
      ['s01', 's01'],
      ['ghost', 's02'],
    ],
    students,
    rows: 2,
    cols: 2,
    classroomLayout: {
      rows: 2,
      cols: 2,
      cells: [
        ['seat', 'seat'],
        ['aisle', 'seat'],
      ],
    },
    unassigned: ['s03'],
    constraints: [
      { type: 'front_row', target: 's04', priority: 'hard' },
    ],
    strategy: { genderBalance: false, heightOrder: false, gradeStrategy: 'none' },
  });

  assert.equal(result.feasible, false);
  assert.ok(result.percent < 60);
  assert.ok(result.hardScore < 0);
  assert.ok(result.constraints.some(item => item.id === 'layout.duplicates'));
  assert.ok(result.constraints.some(item => item.id === 'layout.nonSeatAssignments'));
  assert.ok(result.constraints.some(item => item.id === 'layout.missingStudents'));
  assert.ok(result.topIssues.length > 0);
});

test('evaluateSeatingQuality scores soft needs and only enabled strategy preferences', () => {
  const layout = [
    ['s01', 's03'],
    ['s02', 's04'],
  ];
  const softNeed = [{ type: 'prefer', target: 's01', related: 's04', priority: 'soft' }];

  const withoutStrategy = evaluateSeatingQuality({
    layout,
    students,
    rows: 2,
    cols: 2,
    classroomLayout: {
      rows: 2,
      cols: 2,
      cells: [['seat', 'seat'], ['seat', 'seat']],
    },
    constraints: softNeed,
    strategy: { genderBalance: false, heightOrder: false, gradeStrategy: 'none' },
  });
  const withGender = evaluateSeatingQuality({
    layout,
    students,
    rows: 2,
    cols: 2,
    classroomLayout: {
      rows: 2,
      cols: 2,
      cells: [['seat', 'seat'], ['seat', 'seat']],
    },
    constraints: softNeed,
    strategy: { genderBalance: true, heightOrder: false, gradeStrategy: 'none' },
  });

  assert.equal(withoutStrategy.feasible, true);
  assert.ok(withoutStrategy.softScore < 0);
  assert.equal(withoutStrategy.constraints.some(item => item.id === 'strategy.gender.adjacent'), false);
  assert.ok(withGender.softScore < withoutStrategy.softScore);
  assert.ok(withGender.constraints.some(item => item.id === 'strategy.gender.adjacent'));
  assert.ok(withGender.percent >= 60);
});

test('evaluateSeatingQuality treats a local aisle as separating adjacent seats', () => {
  const localStudents = [
    { id: 'a', name: 'Alice', gender: 'M' },
    { id: 'b', name: 'Bob', gender: 'M' },
  ];
  const layout = [['a', 'b']];
  const classroomLayout = {
    rows: 1,
    cols: 2,
    cells: [['seat', 'seat']],
  };
  const avoidConstraint = [{ type: 'avoid', target: 'a', related: 'b', priority: 'hard' }];

  const withoutAisle = evaluateSeatingQuality({
    layout,
    students: localStudents,
    rows: 1,
    cols: 2,
    classroomLayout,
    constraints: avoidConstraint,
    strategy: { genderBalance: true, heightOrder: false, gradeStrategy: 'none' },
  });
  const withAisle = evaluateSeatingQuality({
    layout,
    students: localStudents,
    rows: 1,
    cols: 2,
    classroomLayout: {
      ...classroomLayout,
      localAisles: { vertical: [{ row: 0, col: 0 }], horizontal: [] },
    },
    constraints: avoidConstraint,
    strategy: { genderBalance: true, heightOrder: false, gradeStrategy: 'none' },
  });

  assert.equal(withoutAisle.feasible, false);
  assert.ok(withoutAisle.constraints.some(item => item.id === 'needs.hard'));
  assert.ok(withoutAisle.constraints.some(item => item.id === 'strategy.gender.adjacent'));
  assert.equal(withAisle.feasible, true);
  assert.equal(withAisle.constraints.some(item => item.id === 'needs.hard'), false);
  assert.equal(withAisle.constraints.some(item => item.id === 'strategy.gender.adjacent'), false);
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

test('parseFallbackSeatingOperations can choose high-grade guardian students', () => {
  const parsed = parseFallbackSeatingOperations({
    message: '左右护法要两个成绩比较好的',
    layout: [
      ['s01', 's02'],
      ['s03', 's04'],
    ],
    students,
    rows: 2,
    cols: 2,
  });

  assert.equal(parsed.mutationIntent, true);
  assert.deepEqual(parsed.operations, [
    { type: 'set_guardian', studentId: 's04', side: 'left' },
    { type: 'set_guardian', studentId: 's01', side: 'right' },
  ]);
});

test('parseFallbackSeatingOperations chooses average-grade guardian by side and gender', () => {
  const roster = [
    { id: 'm_high', name: '高男', gender: 'M', grade: 100 },
    { id: 'f_low', name: '低女', gender: 'F', grade: 50 },
    { id: 'f_avg', name: '中女', gender: 'F', grade: 78 },
    { id: 'm_avg', name: '中男', gender: 'M', grade: 76 },
    { id: 'm_low', name: '低男', gender: 'M', grade: 55 },
  ];

  const female = parseFallbackSeatingOperations({
    message: '右护法变成一个成绩一般的女生',
    layout: [
      ['m_high', 'f_low', 'f_avg'],
      ['m_avg', 'm_low', null],
    ],
    students: roster,
    guardians: ['m_high', 'f_low'],
    rows: 2,
    cols: 3,
  });
  assert.deepEqual(female.operations, [
    { type: 'set_guardian', studentId: 'f_avg', side: 'right' },
  ]);

  const male = parseFallbackSeatingOperations({
    message: '右护法变成一个成绩一般的男生',
    layout: [
      ['m_high', 'f_low', 'f_avg'],
      ['m_avg', 'm_low', null],
    ],
    students: roster,
    guardians: ['m_high', 'f_low'],
    rows: 2,
    cols: 3,
  });
  assert.deepEqual(male.operations, [
    { type: 'set_guardian', studentId: 'm_avg', side: 'right' },
  ]);
});

test('parseFallbackSeatingOperations treats comparative grades as quartiles, not extremes', () => {
  const roster = [
    { id: 's100', name: '最高', gender: 'M', grade: 100 },
    { id: 's90', name: '较好', gender: 'M', grade: 90 },
    { id: 's80', name: '中上', gender: 'F', grade: 80 },
    { id: 's70', name: '中等', gender: 'F', grade: 70 },
    { id: 's60', name: '较差', gender: 'M', grade: 60 },
    { id: 's50', name: '最低', gender: 'F', grade: 50 },
  ];

  const good = parseFallbackSeatingOperations({
    message: '左护法变成一个成绩较好的男生',
    layout: [['s100', 's90', 's80'], ['s70', 's60', 's50']],
    students: roster,
    guardians: ['s50', null],
    rows: 2,
    cols: 3,
  });
  assert.deepEqual(good.operations, [
    { type: 'set_guardian', studentId: 's90', side: 'left' },
  ]);

  const poor = parseFallbackSeatingOperations({
    message: '右护法变成一个成绩较差的女生',
    layout: [['s100', 's90', 's80'], ['s70', 's60', 's50']],
    students: roster,
    guardians: [null, 's100'],
    rows: 2,
    cols: 3,
  });
  assert.deepEqual(poor.operations, [
    { type: 'set_guardian', studentId: 's70', side: 'right' },
  ]);
});

test('parseFallbackSeatingOperations resolves row middle to nearest usable seat', () => {
  const parsed = parseFallbackSeatingOperations({
    message: '把Sue调到第2排中间位置',
    layout: [
      [null, null, null, null, null],
      ['s01', null, null, null, null],
    ],
    students: [{ id: 's01', name: 'Sue' }],
    rows: 2,
    cols: 5,
    blockedCells: [{ r: 1, c: 2 }],
  });

  assert.equal(parsed.mutationIntent, true);
  assert.deepEqual(parsed.operations, [{ type: 'move', studentId: 's01', row: 1, col: 1 }]);
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
