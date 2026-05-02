import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildArrangeRepairPrompt,
  runAiDrivenArrangement,
  shouldAllowUnassigned,
  normalizeArrangeRequest,
  validateAiArrangement,
} from '../gateway/services/seating-arrange.js';
import { evaluateSeatingQuality } from '../public/js/tools/seating-core.js';

const students = [
  { id: 's01', name: 'Zhang San', gender: 'M', grade: 91 },
  { id: 's02', name: 'Li Si', gender: 'F', grade: 82 },
  { id: 's03', name: 'Wang Wu', gender: 'M', grade: 76 },
  { id: 's04', name: 'Zhao Liu', gender: 'F', grade: 88 },
];

test('normalizeArrangeRequest requires prompt and student ids', () => {
  const result = normalizeArrangeRequest({
    prompt: '三人一组，中间留过道',
    students,
    constraints: [{ type: 'avoid', target: 'Zhang San', related: 'Li Si' }],
    strategy: { genderBalance: true },
  });

  assert.equal(result.prompt, '三人一组，中间留过道');
  assert.equal(result.students.length, 4);
  assert.deepEqual(result.strategy, { genderBalance: true });

  assert.throws(() => normalizeArrangeRequest({ prompt: '', students }), /排座需求/);
  assert.throws(() => normalizeArrangeRequest({ prompt: '随便排', students: [{ name: 'No ID' }] }), /学生 id/);
});

test('validateAiArrangement accepts a full AI layout and assignments', () => {
  const result = validateAiArrangement({
    raw: {
      reply: '已按中间过道排好座位',
      classroomLayout: {
        rows: 2,
        cols: 3,
        cells: [
          ['seat', 'aisle', 'seat'],
          ['seat', 'seat', 'seat'],
        ],
        groups: [
          [1, null, 2],
          [3, 3, 4],
        ],
        guardians: { enabled: true, left: 's03', right: null },
      },
      assignments: [
        { studentId: 's01', row: 0, col: 0 },
        { studentId: 's02', row: 0, col: 2 },
      ],
      guardians: { left: 's03', right: null },
      unassigned: ['s04'],
      warnings: ['1名学生未安排'],
      reasoning: '中间列留给过道',
    },
    students,
    allowUnassigned: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.classroomLayout.rows, 2);
  assert.equal(result.data.classroomLayout.cols, 3);
  assert.deepEqual(result.data.assignments, [
    { studentId: 's01', row: 0, col: 0 },
    { studentId: 's02', row: 0, col: 2 },
  ]);
  assert.deepEqual(result.data.guardians, { left: 's03', right: null });
  assert.deepEqual(result.data.unassigned, ['s04']);
  assert.match(result.data.reply, /排好/);
});

test('validateAiArrangement rejects unassigned students by default so the room expands', () => {
  const result = validateAiArrangement({
    raw: {
      classroomLayout: {
        rows: 2,
        cols: 2,
        cells: [
          ['seat', 'seat'],
          ['seat', 'seat'],
        ],
      },
      assignments: [
        { studentId: 's01', row: 0, col: 0 },
        { studentId: 's02', row: 0, col: 1 },
        { studentId: 's03', row: 1, col: 0 },
      ],
      unassigned: ['s04'],
    },
    students,
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(';'), /不能留下未安排学生/);
  assert.equal(shouldAllowUnassigned('60个人，三人一组，中间过道'), false);
  assert.equal(shouldAllowUnassigned('教室只有5排8列，尽量安排'), true);
});

test('validateAiArrangement rejects unsafe AI seat plans', () => {
  const duplicate = validateAiArrangement({
    raw: {
      classroomLayout: {
        rows: 1,
        cols: 3,
        cells: [['seat', 'aisle', 'seat']],
      },
      assignments: [
        { studentId: 's01', row: 0, col: 0 },
        { studentId: 's01', row: 0, col: 2 },
      ],
      unassigned: ['s02', 's03', 's04'],
    },
    students,
    allowUnassigned: true,
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.errors.join(';'), /重复/);

  const aisle = validateAiArrangement({
    raw: {
      classroomLayout: {
        rows: 1,
        cols: 3,
        cells: [['seat', 'aisle', 'seat']],
      },
      assignments: [{ studentId: 's01', row: 0, col: 1 }],
      unassigned: ['s02', 's03', 's04'],
    },
    students,
    allowUnassigned: true,
  });
  assert.equal(aisle.ok, false);
  assert.match(aisle.errors.join(';'), /非座位/);

  const missing = validateAiArrangement({
    raw: {
      classroomLayout: {
        rows: 2,
        cols: 2,
        cells: [
          ['seat', 'seat'],
          ['seat', 'seat'],
        ],
      },
      assignments: [{ studentId: 's01', row: 0, col: 0 }],
      unassigned: ['s02'],
    },
    students,
    allowUnassigned: true,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(';'), /缺少学生/);
});

test('validateAiArrangement accepts matrix responses and repair prompt includes errors', () => {
  const result = validateAiArrangement({
    raw: {
      matrix: [
        [1, 0],
        [1, 1],
      ],
      assignments: [
        { studentId: 's01', row: 0, col: 0 },
        { studentId: 's02', row: 1, col: 0 },
      ],
      unassigned: ['s03', 's04'],
    },
    students,
    allowUnassigned: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.classroomLayout.cells, [
    ['seat', 'aisle'],
    ['seat', 'seat'],
  ]);

  assert.match(buildArrangeRepairPrompt(['s01 重复安排', 's03 缺少学生']), /只修正 JSON/);
  assert.match(buildArrangeRepairPrompt(['s01 重复安排', 's03 缺少学生']), /s01 重复安排/);
});

test('runAiDrivenArrangement lets AI return rules and locally seats 60 students with guardians', async () => {
  const manyStudents = Array.from({ length: 60 }, (_, index) => ({
    id: `s${String(index + 1).padStart(2, '0')}`,
    name: `Student ${index + 1}`,
    gender: index % 2 === 0 ? 'M' : 'F',
    grade: 70 + index,
  }));
  manyStudents[4].grade = 10;
  manyStudents[54].grade = 11;
  const request = normalizeArrangeRequest({
    prompt: '60个人，三个人一组，每组之间留横过道和竖过道，成绩最差的坐在左右护法的位置',
    students: manyStudents,
    constraints: [],
    strategy: { genderBalance: true },
    previousLayout: {
      rows: 6,
      cols: 8,
      cells: Array.from({ length: 6 }, () => Array(8).fill('seat')),
    },
  });
  const stages = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    const payload = JSON.parse(body.messages.at(-1).content);
    stages.push(payload.stage);
    assert.equal(payload.stage, 'arrangement_spec');
    assert.equal(payload.studentCount, 60);
    assert.equal(Boolean(payload.students), false);
    return jsonResponse({
      groupSize: 3,
      aislePolicy: { verticalBetweenGroups: true, horizontalBetweenGroupRows: true },
      guardianPolicy: { enabled: true, strategy: 'lowest_grade' },
      layoutMode: 'grouped',
      placementPolicy: { genderBalance: true },
      notes: 'rules only',
    });
  };

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl,
    env: { DEEPSEEK_API_BASE: 'http://fake-ai', DEEPSEEK_API_KEY: 'key' },
  });

  assert.equal(result.source, 'ai_spec_local_algorithm');
  assert.equal(result.assignments.length, 58);
  assert.deepEqual(new Set([result.guardians.left, result.guardians.right]), new Set(['s05', 's55']));
  assert.equal(result.unassigned.length, 0);
  assert.equal(new Set(result.assignments.map(item => item.studentId)).size, 58);
  assert.equal(new Set(result.assignments.map(item => `${item.row},${item.col}`)).size, 58);
  assert.ok(result.classroomLayout.rows > 6 || result.classroomLayout.cols > 8);
  assert.ok(result.classroomLayout.cells.flat().includes('aisle'));
  assert.equal(result.arrangementSpec.groupSize, 3);
  assert.deepEqual(stages, ['arrangement_spec']);
});

test('runAiDrivenArrangement expands beyond old 20x20 limits for large rosters', async () => {
  const manyStudents = Array.from({ length: 5000 }, (_, index) => ({
    id: `s${String(index + 1).padStart(5, '0')}`,
    name: `Student ${index + 1}`,
    grade: index % 100,
  }));
  const request = normalizeArrangeRequest({
    prompt: '5000个人，三个人一组，每组之间留竖过道',
    students: manyStudents,
    previousLayout: {
      rows: 6,
      cols: 8,
      cells: Array.from({ length: 6 }, () => Array(8).fill('seat')),
    },
  });
  const fetchImpl = async () => jsonResponse({
    groupSize: 3,
    aislePolicy: { verticalBetweenGroups: true, horizontalBetweenGroupRows: false },
    guardianPolicy: { enabled: false },
    layoutMode: 'grouped',
  });

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl,
    env: { DEEPSEEK_API_BASE: 'http://fake-ai', DEEPSEEK_API_KEY: 'key' },
  });

  assert.equal(result.assignments.length, 5000);
  assert.equal(result.unassigned.length, 0);
  assert.ok(result.classroomLayout.rows > 20);
  assert.equal(result.stats.studentCount, 5000);
  assert.equal(result.stats.guardianSeatCount, 0);
  assert.equal(new Set(result.assignments.map(item => item.studentId)).size, 5000);
});

test('height care and grade priority both apply within the same arrangement', async () => {
  const roster = [
    { id: 's01', name: 'Tall Top', height: 190, grade: 100, gender: 'M' },
    { id: 's02', name: 'Short Low', height: 150, grade: 10, gender: 'F' },
    { id: 's03', name: 'Short Top', height: 151, grade: 99, gender: 'M' },
    { id: 's04', name: 'Short Mid', height: 152, grade: 80, gender: 'F' },
    { id: 's05', name: 'Short Lower', height: 153, grade: 70, gender: 'M' },
    { id: 's06', name: 'Mid A', height: 160, grade: 95, gender: 'F' },
    { id: 's07', name: 'Mid B', height: 161, grade: 30, gender: 'M' },
    { id: 's08', name: 'Mid C', height: 162, grade: 90, gender: 'F' },
    { id: 's09', name: 'Tall A', height: 180, grade: 85, gender: 'M' },
    { id: 's10', name: 'Tall B', height: 181, grade: 20, gender: 'F' },
    { id: 's11', name: 'Tall C', height: 182, grade: 75, gender: 'M' },
    { id: 's12', name: 'Tall D', height: 183, grade: 40, gender: 'F' },
  ];
  const request = normalizeArrangeRequest({
    prompt: '12个人，普通教室',
    students: roster,
    strategy: { genderBalance: false, heightOrder: true, gradeStrategy: 'priority' },
  });
  const fetchImpl = async () => jsonResponse({
    groupSize: 1,
    guardianPolicy: { enabled: false },
    layoutMode: 'standard',
  });

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl,
    env: { DEEPSEEK_API_BASE: 'http://fake-ai', DEEPSEEK_API_KEY: 'key' },
  });

  const byStudent = new Map(result.assignments.map(item => [item.studentId, item]));
  assert.equal(byStudent.get('s01').row, 1);
  assert.ok([1, 2].includes(byStudent.get('s01').col));
  assert.equal(byStudent.get('s03').row, 0);
  assert.ok([1, 2].includes(byStudent.get('s03').col));
  assert.equal(byStudent.get('s06').row, 1);
  assert.ok([1, 2].includes(byStudent.get('s06').col));
  assert.ok(result.stats.appliedStrategies.includes('身高照顾'));
  assert.ok(result.stats.appliedStrategies.includes('优秀优先'));
});

test('grade priority balances with height care by choosing centered seats within height rows', async () => {
  const roster = Array.from({ length: 20 }, (_, index) => ({
    id: `s${String(index + 1).padStart(2, '0')}`,
    name: `Student ${index + 1}`,
    grade: index + 1,
    height: 140 + index,
  }));
  const request = normalizeArrangeRequest({
    prompt: '20 students, use the existing room',
    students: roster,
    strategy: { genderBalance: false, heightOrder: true, gradeStrategy: 'priority' },
    previousLayout: {
      rows: 6,
      cols: 6,
      cells: Array.from({ length: 6 }, () => Array(6).fill('seat')),
    },
  });
  const fetchImpl = async () => jsonResponse({
    groupSize: 1,
    guardianPolicy: { enabled: false },
    keepPreviousLayout: true,
    layoutMode: 'standard',
  });

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl,
    env: { DEEPSEEK_API_BASE: 'http://fake-ai', DEEPSEEK_API_KEY: 'key' },
  });

  const byStudent = new Map(result.assignments.map(item => [item.studentId, item]));
  assert.deepEqual(
    ['s20', 's19', 's18', 's17'].map(id => `${byStudent.get(id).row},${byStudent.get(id).col}`),
    ['3,2', '3,3', '2,2', '2,3'],
  );
  assert.equal(byStudent.get('s01').row, 0);
});

test('height plus grade priority prefers the classroom center across aisle-separated groups', async () => {
  const roster = Array.from({ length: 20 }, (_, index) => ({
    id: `s${String(index + 1).padStart(2, '0')}`,
    name: `Student ${index + 1}`,
    grade: index + 1,
    height: 140 + index,
  }));
  const groupedRow = ['seat', 'seat', 'aisle', 'seat', 'seat', 'aisle', 'seat', 'seat', 'aisle', 'seat', 'seat'];
  const request = normalizeArrangeRequest({
    prompt: '20 students, use the existing grouped room',
    students: roster,
    strategy: { genderBalance: false, heightOrder: true, gradeStrategy: 'priority' },
    previousLayout: {
      rows: 6,
      cols: 11,
      cells: Array.from({ length: 6 }, () => [...groupedRow]),
    },
  });
  const fetchImpl = async () => jsonResponse({
    groupSize: 2,
    guardianPolicy: { enabled: false },
    keepPreviousLayout: true,
    layoutMode: 'grouped',
  });

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl,
    env: { DEEPSEEK_API_BASE: 'http://fake-ai', DEEPSEEK_API_KEY: 'key' },
  });

  const byStudent = new Map(result.assignments.map(item => [item.studentId, item]));
  assert.deepEqual(
    ['s20', 's19', 's18', 's17'].map(id => `${byStudent.get(id).row},${byStudent.get(id).col}`),
    ['2,4', '2,6', '2,3', '2,7'],
  );
});

test('height plus grade priority pulls top students out of edge groups when nearby center seats exist', async () => {
  const roster = Array.from({ length: 60 }, (_, index) => ({
    id: `s${String(index + 1).padStart(2, '0')}`,
    name: `Student ${index + 1}`,
    grade: 50 + (index % 30),
    height: 150 + index,
  }));
  for (const index of [0, 1, 12, 13, 24, 25, 36, 37, 48, 49, 58, 59]) {
    roster[index].grade = 100 - index / 100;
  }
  const groupedRow = [
    'seat', 'seat', 'aisle',
    'seat', 'seat', 'aisle',
    'seat', 'seat', 'aisle',
    'seat', 'seat', 'aisle',
    'seat', 'seat', 'aisle',
    'seat', 'seat',
  ];
  const request = normalizeArrangeRequest({
    prompt: '60 students, use the existing grouped room',
    students: roster,
    strategy: { genderBalance: false, heightOrder: true, gradeStrategy: 'priority' },
    previousLayout: {
      rows: 5,
      cols: 17,
      cells: Array.from({ length: 5 }, () => [...groupedRow]),
    },
  });
  const fetchImpl = async () => jsonResponse({
    groupSize: 2,
    guardianPolicy: { enabled: false },
    keepPreviousLayout: true,
    layoutMode: 'grouped',
  });

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl,
    env: { DEEPSEEK_API_BASE: 'http://fake-ai', DEEPSEEK_API_KEY: 'key' },
  });

  const edgeCols = new Set([0, 1, 15, 16]);
  const byStudent = new Map(result.assignments.map(item => [item.studentId, item]));
  for (const id of ['s01', 's02', 's13', 's14', 's25', 's26', 's37', 's38', 's49', 's50', 's59', 's60']) {
    assert.ok(!edgeCols.has(byStudent.get(id).col), `${id} should not remain in an edge group`);
  }
});

test('grade priority gives top 20 percent the center-front golden seats', async () => {
  const roster = Array.from({ length: 20 }, (_, index) => ({
    id: `s${String(index + 1).padStart(2, '0')}`,
    name: `Student ${index + 1}`,
    grade: index + 1,
  }));
  const request = normalizeArrangeRequest({
    prompt: '20 students, use the existing room',
    students: roster,
    strategy: { genderBalance: false, heightOrder: false, gradeStrategy: 'priority' },
    previousLayout: {
      rows: 6,
      cols: 6,
      cells: Array.from({ length: 6 }, () => Array(6).fill('seat')),
    },
  });
  const fetchImpl = async () => jsonResponse({
    groupSize: 1,
    guardianPolicy: { enabled: false },
    keepPreviousLayout: true,
    layoutMode: 'standard',
  });

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl,
    env: { DEEPSEEK_API_BASE: 'http://fake-ai', DEEPSEEK_API_KEY: 'key' },
  });

  const byStudent = new Map(result.assignments.map(item => [item.studentId, item]));
  assert.deepEqual(
    ['s20', 's19', 's18', 's17'].map(id => `${byStudent.get(id).row},${byStudent.get(id).col}`),
    ['2,2', '2,3', '1,2', '1,3'],
  );
});

test('grade priority does not override hard front-row requirements', async () => {
  const roster = Array.from({ length: 20 }, (_, index) => ({
    id: `s${String(index + 1).padStart(2, '0')}`,
    name: index === 0 ? 'Front Required' : `Student ${index + 1}`,
    grade: index === 0 ? 1 : index + 1,
  }));
  const request = normalizeArrangeRequest({
    prompt: '20 students, use the existing room',
    students: roster,
    constraints: [{ type: 'front_row', target: 'Front Required', priority: 'hard' }],
    strategy: { genderBalance: false, heightOrder: false, gradeStrategy: 'priority' },
    previousLayout: {
      rows: 6,
      cols: 6,
      cells: Array.from({ length: 6 }, () => Array(6).fill('seat')),
    },
  });
  const fetchImpl = async () => jsonResponse({
    groupSize: 1,
    guardianPolicy: { enabled: false },
    keepPreviousLayout: true,
    layoutMode: 'standard',
  });

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl,
    env: { DEEPSEEK_API_BASE: 'http://fake-ai', DEEPSEEK_API_KEY: 'key' },
  });

  const byStudent = new Map(result.assignments.map(item => [item.studentId, item]));
  assert.ok(byStudent.get('s01').row <= 1);
  assert.deepEqual(
    ['s20', 's19', 's18', 's17'].map(id => `${byStudent.get(id).row},${byStudent.get(id).col}`),
    ['2,2', '2,3', '1,3', '3,2'],
  );
});

test('grade priority keeps excellent students out of the last row after gender balancing', async () => {
  const roster = [
    { id: 'm01', name: 'Low M1', grade: 10, gender: 'M' },
    { id: 'm02', name: 'Low M2', grade: 20, gender: 'M' },
    { id: 'm03', name: 'Low M3', grade: 30, gender: 'M' },
    { id: 'm04', name: 'Low M4', grade: 40, gender: 'M' },
    { id: 'm05', name: 'Low M5', grade: 50, gender: 'M' },
    { id: 'f01', name: 'Top F1', grade: 100, gender: 'F' },
    { id: 'f02', name: 'Top F2', grade: 98, gender: 'F' },
    { id: 'f03', name: 'Top F3', grade: 96, gender: 'F' },
  ];
  const request = normalizeArrangeRequest({
    prompt: '8个人，普通教室',
    students: roster,
    strategy: { genderBalance: true, heightOrder: false, gradeStrategy: 'priority' },
  });
  const fetchImpl = async () => jsonResponse({
    groupSize: 1,
    guardianPolicy: { enabled: false },
    layoutMode: 'standard',
  });

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl,
    env: { DEEPSEEK_API_BASE: 'http://fake-ai', DEEPSEEK_API_KEY: 'key' },
  });

  const lastRow = Math.max(...result.assignments.map(item => item.row));
  const rosterById = new Map(roster.map(student => [student.id, student]));
  const topTwoInLastRow = result.assignments
    .filter(item => item.row === lastRow)
    .filter(item => rosterById.get(item.studentId).grade >= 98);
  assert.deepEqual(topTwoInLastRow, []);
});

test('high-grade guardian prompt selects top 20 percent students without AI', async () => {
  const roster = [
    { id: 's01', name: 'Low A', grade: 10 },
    { id: 's02', name: 'Low B', grade: 20 },
    { id: 's03', name: 'Low C', grade: 30 },
    { id: 's04', name: 'Low D', grade: 40 },
    { id: 's05', name: 'Mid A', grade: 50 },
    { id: 's06', name: 'Mid B', grade: 60 },
    { id: 's07', name: 'High A', grade: 99 },
    { id: 's08', name: 'High B', grade: 100 },
  ];
  const request = normalizeArrangeRequest({
    prompt: '讲台旁安排左右护法，成绩比较好的坐护法',
    students: roster,
  });

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl: undefined,
    env: {},
  });

  assert.deepEqual(new Set([result.guardians.left, result.guardians.right]), new Set(['s07', 's08']));
  assert.equal(result.arrangementSpec.guardianPolicy.strategy, 'top_grade_percent');
});

test('AI highest-grade guardian policy is normalized and does not fall back to low scores', async () => {
  const roster = [
    { id: 's01', name: 'Low A', grade: 10 },
    { id: 's02', name: 'Low B', grade: 20 },
    { id: 's03', name: 'Mid A', grade: 70 },
    { id: 's04', name: 'High A', grade: 90 },
    { id: 's05', name: 'High B', grade: 95 },
    { id: 's06', name: 'High C', grade: 100 },
  ];
  const request = normalizeArrangeRequest({
    prompt: '讲台旁安排左右护法，成绩比较好的坐护法',
    students: roster,
  });
  const fetchImpl = async () => jsonResponse({
    guardianPolicy: { enabled: true, strategy: 'highest_grade' },
    layoutMode: 'standard',
  });

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl,
    env: { DEEPSEEK_API_BASE: 'http://fake-ai', DEEPSEEK_API_KEY: 'key' },
  });

  assert.deepEqual(new Set([result.guardians.left, result.guardians.right]), new Set(['s05', 's06']));
  assert.equal(result.arrangementSpec.guardianPolicy.strategy, 'top_grade_percent');
});

test('AI low-grade guardian policy wins over a high-grade wording fallback', async () => {
  const roster = [
    { id: 's01', name: 'Low A', grade: 10 },
    { id: 's02', name: 'Low B', grade: 20 },
    { id: 's03', name: 'Mid A', grade: 70 },
    { id: 's04', name: 'High A', grade: 90 },
    { id: 's05', name: 'High B', grade: 95 },
    { id: 's06', name: 'High C', grade: 100 },
  ];
  const request = normalizeArrangeRequest({
    prompt: '讲台旁安排左右护法，成绩比较好的坐护法',
    students: roster,
  });
  const fetchImpl = async () => jsonResponse({
    guardianPolicy: { enabled: true, strategy: 'lowest_grade' },
    layoutMode: 'standard',
  });

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl,
    env: { DEEPSEEK_API_BASE: 'http://fake-ai', DEEPSEEK_API_KEY: 'key' },
  });

  assert.deepEqual(new Set([result.guardians.left, result.guardians.right]), new Set(['s01', 's02']));
  assert.equal(result.arrangementSpec.guardianPolicy.strategy, 'lowest_grade');
});

test('AI mixed guardian slots can require top and lowest grades with different genders', async () => {
  const roster = [
    { id: 'm_low', name: 'Low Male', grade: 10, gender: 'M' },
    { id: 'f_low', name: 'Low Female', grade: 20, gender: 'F' },
    { id: 'm_mid', name: 'Mid Male', grade: 70, gender: 'M' },
    { id: 'f_top', name: 'Top Female', grade: 100, gender: 'F' },
  ];
  const request = normalizeArrangeRequest({
    prompt: '左右护法一个男一个女，一个前20%，一个最低分',
    students: roster,
  });
  const fetchImpl = async () => jsonResponse({
    guardianPolicy: {
      enabled: true,
      slots: [
        { gender: 'F', strategy: 'top_grade_percent' },
        { gender: 'M', strategy: 'lowest_grade' },
      ],
    },
    layoutMode: 'standard',
  });

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl,
    env: { DEEPSEEK_API_BASE: 'http://fake-ai', DEEPSEEK_API_KEY: 'key' },
  });

  assert.deepEqual([result.guardians.left, result.guardians.right], ['f_top', 'm_low']);
  assert.deepEqual(result.arrangementSpec.guardianPolicy.slots, [
    { gender: 'F', strategy: 'top_grade_percent' },
    { gender: 'M', strategy: 'lowest_grade' },
  ]);
});

test('later high-grade guardian wording overrides earlier low-grade guardian wording', async () => {
  const roster = [
    { id: 's01', name: 'Low A', grade: 10 },
    { id: 's02', name: 'Low B', grade: 20 },
    { id: 's03', name: 'Mid A', grade: 70 },
    { id: 's04', name: 'High A', grade: 80 },
    { id: 's05', name: 'High B', grade: 90 },
    { id: 's06', name: 'High C', grade: 100 },
  ];
  const request = normalizeArrangeRequest({
    prompt: '先把成绩差的放左右护法，后面改成成绩比较好的坐护法',
    students: roster,
  });

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl: undefined,
    env: {},
  });

  assert.deepEqual(new Set([result.guardians.left, result.guardians.right]), new Set(['s05', 's06']));
  assert.equal(result.arrangementSpec.guardianPolicy.strategy, 'top_grade_percent');
});

test('AI prompt can disable a UI strategy preference', async () => {
  const roster = [
    { id: 's01', name: 'Input First Tall', height: 190, grade: 80 },
    { id: 's02', name: 'Input Second Short', height: 140, grade: 70 },
    { id: 's03', name: 'Input Third', height: 150, grade: 60 },
    { id: 's04', name: 'Input Fourth', height: 160, grade: 50 },
  ];
  const request = normalizeArrangeRequest({
    prompt: '不要按身高排，普通安排',
    students: roster,
    strategy: { genderBalance: false, heightOrder: true, gradeStrategy: 'none' },
  });
  const fetchImpl = async () => jsonResponse({
    groupSize: 1,
    guardianPolicy: { enabled: false },
    layoutMode: 'standard',
  });

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl,
    env: { DEEPSEEK_API_BASE: 'http://fake-ai', DEEPSEEK_API_KEY: 'key' },
  });

  const firstSeat = result.assignments.find(item => item.row === 0 && item.col === 0);
  assert.equal(firstSeat.studentId, 's01');
  assert.equal(result.arrangementSpec.placementPolicy.heightOrder, false);
  assert.ok(!result.stats.appliedStrategies.includes('身高照顾'));
  assert.ok(result.warnings.some(warning => warning.includes('关闭身高')));
});

test('runAiDrivenArrangement uses Timefold when configured and solution is feasible', async () => {
  const roster = [
    { id: 's01', name: 'A', grade: 90 },
    { id: 's02', name: 'B', grade: 80 },
    { id: 's03', name: 'C', grade: 70 },
    { id: 's04', name: 'D', grade: 60 },
  ];
  const request = normalizeArrangeRequest({
    prompt: '4 students, keep the room',
    students: roster,
    previousLayout: {
      rows: 2,
      cols: 2,
      cells: [
        ['seat', 'seat'],
        ['seat', 'seat'],
      ],
    },
  });
  const fetchImpl = async (url, options = {}) => {
    if (String(url).startsWith('http://fake-ai')) {
      return jsonResponse({
        groupSize: 1,
        guardianPolicy: { enabled: false },
        keepPreviousLayout: true,
        layoutMode: 'standard',
      });
    }
    if (options.method === 'POST') return textResponse({ jobId: 'job-1' }, 202);
    if (String(url).endsWith('/status')) {
      return textResponse({ jobId: 'job-1', solverStatus: 'NOT_SOLVING', hardScore: 0, softScore: 12 }, 200);
    }
    if (options.method === 'DELETE') return textResponse({}, 204);
    return textResponse({
      jobId: 'job-1',
      hardScore: 0,
      softScore: 12,
      students: [
        { id: 's01', seat: 'r0c1' },
        { id: 's02', seat: 'r0c0' },
        { id: 's03', seat: 'r1c0' },
        { id: 's04', seat: 'r1c1' },
      ],
    }, 200);
  };

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl,
    env: {
      DEEPSEEK_API_BASE: 'http://fake-ai',
      DEEPSEEK_API_KEY: 'key',
      TIMEFOLD_SOLVER_URL: 'http://solver',
      TIMEFOLD_SOLVER_TIMEOUT: '1',
    },
  });

  assert.equal(result.source, 'timefold_solver');
  assert.deepEqual(result.assignments.map(item => `${item.studentId}:${item.row},${item.col}`), [
    's01:0,1',
    's02:0,0',
    's03:1,0',
    's04:1,1',
  ]);
});

test('runAiDrivenArrangement falls back to local seating when Timefold has hard violations', async () => {
  const roster = [
    { id: 's01', name: 'A', grade: 90 },
    { id: 's02', name: 'B', grade: 80 },
    { id: 's03', name: 'C', grade: 70 },
    { id: 's04', name: 'D', grade: 60 },
  ];
  const request = normalizeArrangeRequest({
    prompt: '4 students, keep the room',
    students: roster,
    previousLayout: {
      rows: 2,
      cols: 2,
      cells: [
        ['seat', 'seat'],
        ['seat', 'seat'],
      ],
    },
  });
  const fetchImpl = async (url, options = {}) => {
    if (String(url).startsWith('http://fake-ai')) {
      return jsonResponse({
        groupSize: 1,
        guardianPolicy: { enabled: false },
        keepPreviousLayout: true,
        layoutMode: 'standard',
      });
    }
    if (options.method === 'POST') return textResponse({ jobId: 'job-1' }, 202);
    if (String(url).endsWith('/status')) {
      return textResponse({ jobId: 'job-1', solverStatus: 'NOT_SOLVING', hardScore: -1, softScore: 0 }, 200);
    }
    if (options.method === 'DELETE') return textResponse({}, 204);
    return textResponse({
      jobId: 'job-1',
      hardScore: -1,
      softScore: 0,
      students: [
        { id: 's01', seat: 'r0c0' },
        { id: 's02', seat: 'r0c0' },
      ],
    }, 200);
  };

  const result = await runAiDrivenArrangement({
    request,
    fetchImpl,
    env: {
      DEEPSEEK_API_BASE: 'http://fake-ai',
      DEEPSEEK_API_KEY: 'key',
      TIMEFOLD_SOLVER_URL: 'http://solver',
      TIMEFOLD_SOLVER_TIMEOUT: '1',
    },
  });

  assert.equal(result.source, 'ai_spec_local_algorithm');
  assert.equal(result.assignments.length, 4);
  assert.equal(result.warnings.some(warning => warning.includes('Timefold solver unavailable')), true);
});

test('Timefold result can be evaluated with the existing quality scorer and is not worse than local', async () => {
  const roster = [
    { id: 's01', name: 'A', grade: 90, gender: 'M' },
    { id: 's02', name: 'B', grade: 80, gender: 'F' },
    { id: 's03', name: 'C', grade: 70, gender: 'M' },
    { id: 's04', name: 'D', grade: 60, gender: 'F' },
  ];
  const request = normalizeArrangeRequest({
    prompt: '4 students, keep the room',
    students: roster,
    strategy: { genderBalance: false, heightOrder: false, gradeStrategy: 'none' },
    previousLayout: {
      rows: 2,
      cols: 2,
      cells: [
        ['seat', 'seat'],
        ['seat', 'seat'],
      ],
    },
  });
  const aiSpec = {
    groupSize: 1,
    guardianPolicy: { enabled: false },
    keepPreviousLayout: true,
    layoutMode: 'standard',
    placementPolicy: { genderBalance: false, heightOrder: false, gradeStrategy: 'none' },
  };
  const local = await runAiDrivenArrangement({
    request,
    fetchImpl: async () => jsonResponse(aiSpec),
    env: { DEEPSEEK_API_BASE: 'http://fake-ai', DEEPSEEK_API_KEY: 'key' },
  });
  const fetchImpl = async (url, options = {}) => {
    if (String(url).startsWith('http://fake-ai')) return jsonResponse(aiSpec);
    if (options.method === 'POST') return textResponse({ jobId: 'job-1' }, 202);
    if (String(url).endsWith('/status')) {
      return textResponse({ jobId: 'job-1', solverStatus: 'NOT_SOLVING', hardScore: 0, softScore: 0 }, 200);
    }
    if (options.method === 'DELETE') return textResponse({}, 204);
    return textResponse({
      jobId: 'job-1',
      hardScore: 0,
      softScore: 0,
      students: [
        { id: 's01', seat: 'r0c0' },
        { id: 's02', seat: 'r0c1' },
        { id: 's03', seat: 'r1c0' },
        { id: 's04', seat: 'r1c1' },
      ],
    }, 200);
  };

  const timefold = await runAiDrivenArrangement({
    request,
    fetchImpl,
    env: {
      DEEPSEEK_API_BASE: 'http://fake-ai',
      DEEPSEEK_API_KEY: 'key',
      TIMEFOLD_SOLVER_URL: 'http://solver',
      TIMEFOLD_SOLVER_TIMEOUT: '1',
    },
  });

  const localQuality = evaluateSeatingQuality({
    layout: assignmentsToLayout(local),
    students: roster,
    classroomLayout: local.classroomLayout,
    strategy: request.strategy,
  });
  const timefoldQuality = evaluateSeatingQuality({
    layout: assignmentsToLayout(timefold),
    students: roster,
    classroomLayout: timefold.classroomLayout,
    strategy: request.strategy,
  });

  assert.equal(timefold.source, 'timefold_solver');
  assert.equal(timefoldQuality.feasible, true);
  assert.ok(timefoldQuality.percent >= localQuality.percent);
});

function assignmentsToLayout(arrangement) {
  const layout = Array.from(
    { length: arrangement.classroomLayout.rows },
    () => Array(arrangement.classroomLayout.cols).fill(null)
  );
  for (const assignment of arrangement.assignments) {
    layout[assignment.row][assignment.col] = assignment.studentId;
  }
  return layout;
}

function textResponse(content, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return status === 204 ? '' : JSON.stringify(content);
    },
  };
}

function jsonResponse(content) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{ message: { content: JSON.stringify(content) } }],
      };
    },
  };
}
