import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTimefoldProblem,
  computeNeighborSeatIds,
  solveWithTimefold,
  TimefoldUnavailableError,
  timefoldSolve,
  transformSolutionToAssignments,
} from '../gateway/services/seating-solver-bridge.js';

const layout = {
  rows: 2,
  cols: 3,
  cells: [
    ['seat', 'seat', 'aisle'],
    ['seat', 'seat', 'seat'],
  ],
  groups: [
    [1, 1, null],
    [2, 2, 3],
  ],
  localAisles: { vertical: [{ row: 0, col: 0 }], horizontal: [] },
};

const students = [
  { id: 's01', name: 'A', grade: 90, gender: 'M' },
  { id: 's02', name: 'B', grade: 80, gender: 'F' },
  { id: 's03', name: 'C', grade: 70, gender: 'M' },
];

test('computeNeighborSeatIds respects local aisles without using group boundaries', () => {
  const seats = [
    { id: 'r0c0', row: 0, col: 0 },
    { id: 'r0c1', row: 0, col: 1 },
    { id: 'r1c0', row: 1, col: 0 },
    { id: 'r1c1', row: 1, col: 1 },
  ];

  const neighbors = computeNeighborSeatIds(
    seats,
    { vertical: [{ row: 0, col: 0 }], horizontal: [] },
    2,
    2
  );

  assert.deepEqual(neighbors.get('r0c0'), ['r1c0']);
  assert.ok(!neighbors.get('r0c0').includes('r0c1'));
  assert.ok(neighbors.get('r1c0').includes('r1c1'));
});

test('buildTimefoldProblem excludes guardians and aisle cells', () => {
  const problem = buildTimefoldProblem({
    request: {
      students,
      constraints: [
        { type: 'front_row', target: 'B' },
        { type: 'pair', target: 'B', related: 'C' },
        { type: 'avoid', target: 's02', related: 's03' },
      ],
    },
    layout,
    spec: { placementPolicy: { gradeStrategy: 'priority', genderBalance: true } },
    guardians: { left: 's01', right: null },
  });

  assert.deepEqual(problem.students.map(student => student.id), ['s02', 's03']);
  assert.equal(problem.seats.length, 5);
  assert.equal(problem.seats.some(seat => seat.id === 'r0c2'), false);
  assert.equal(problem.students[0].mustFrontRow, true);
  assert.deepEqual(problem.students[0].mustPairWith, ['s03']);
  assert.deepEqual(problem.students[0].mustAvoidAdjacent, ['s03']);
  assert.equal(problem.config.gradeStrategy, 'priority');
});

test('buildTimefoldProblem skips Timefold when regular students exceed grid capacity', () => {
  assert.throws(() => buildTimefoldProblem({
    request: {
      students: [
        { id: 's01', name: 'A' },
        { id: 's02', name: 'B' },
      ],
      constraints: [],
    },
    layout: {
      rows: 1,
      cols: 1,
      cells: [['seat']],
      groups: [[1]],
    },
    spec: { placementPolicy: {} },
    guardians: {},
  }), error => error instanceof TimefoldUnavailableError && error.reason === 'capacity_exceeded');
});

test('transformSolutionToAssignments converts Timefold seats back to current arrangement shape', () => {
  const result = transformSolutionToAssignments({
    hardScore: 0,
    softScore: 12,
    score: '0hard/12soft',
    students: [
      { id: 's01', seat: 'r0c1' },
      { id: 's02', seat: { id: 'r1c0' } },
    ],
  });

  assert.deepEqual(result.assignments, [
    { studentId: 's01', row: 0, col: 1 },
    { studentId: 's02', row: 1, col: 0 },
  ]);
  assert.deepEqual(result.unassigned, []);
  assert.equal(result.hardScore, 0);
  assert.equal(result.softScore, 12);
});

test('timefoldSolve rejects hard-score violations and cleans up the job', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (options.method === 'POST') return jsonResponse({ jobId: 'job-1' }, 202);
    if (url.endsWith('/status')) {
      return jsonResponse({ jobId: 'job-1', solverStatus: 'NOT_SOLVING', hardScore: -1 }, 200);
    }
    if (options.method === 'DELETE') return jsonResponse({}, 204);
    return jsonResponse({
      jobId: 'job-1',
      hardScore: -1,
      softScore: 0,
      students: [{ id: 's01', seat: 'r0c0' }],
    }, 200);
  };

  await assert.rejects(() => timefoldSolve({ seats: [], students: [] }, {
    solverUrl: 'http://solver',
    timeout: 1000,
    fetchImpl,
  }), error => error instanceof TimefoldUnavailableError && error.reason === 'hard_score_violation');

  assert.equal(calls.some(call => call.method === 'DELETE'), true);
});

test('solveWithTimefold is disabled when TIMEFOLD_SOLVER_URL is empty', async () => {
  await assert.rejects(() => solveWithTimefold({
    request: { students, constraints: [] },
    layout,
    spec: { placementPolicy: {} },
    guardians: {},
    env: {},
  }), error => error instanceof TimefoldUnavailableError && error.reason === 'not_configured');
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return status === 204 ? '' : JSON.stringify(payload);
    },
  };
}
