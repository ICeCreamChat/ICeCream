import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSeatingPlanResponse,
  normalizePlanRequest,
} from '../gateway/services/seating-layout.js';

test('normalizePlanRequest preserves template and natural-language layout fields', () => {
  const result = normalizePlanRequest({
    rows: '5',
    cols: '7',
    template: 'triples',
    groupSize: '3',
    guardiansEnabled: true,
    prompt: '三人一组，中间过道',
  });

  assert.deepEqual(result, {
    rows: 5,
    cols: 7,
    template: 'triples',
    groupSize: 3,
    guardiansEnabled: true,
    prompt: '三人一组，中间过道',
  });
});

test('normalizePlanRequest parses disabled guardian strings as false', () => {
  const result = normalizePlanRequest({
    prompt: '开启左右护法',
    guardiansEnabled: 'false',
  });

  assert.equal(result.guardiansEnabled, false);
});

test('buildSeatingPlanResponse accepts valid AI matrices and rejects invalid ones', () => {
  const response = buildSeatingPlanResponse({
    rows: 2,
    cols: 3,
    matrix: [
      [1, 0, 1],
      [1, 1, 0],
    ],
    reasoning: '中间留出通道',
    groupSize: 2,
    guardiansEnabled: false,
  });

  assert.equal(response.reasoning, '中间留出通道');
  assert.equal(response.layout.template, 'custom');
  assert.deepEqual(response.matrix, [
    [1, 0, 1],
    [1, 1, 0],
  ]);

  assert.throws(
    () => buildSeatingPlanResponse({ rows: 2, cols: 3, matrix: [[1, 1, 1]], reasoning: '' }),
    /尺寸/
  );
});
