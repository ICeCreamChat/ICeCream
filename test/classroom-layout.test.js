import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyAiLayoutMatrix,
  createClassroomLayout,
  getLayoutCapacity,
  getLayoutGroups,
  layoutToLegacyAisles,
  parseClassroomLayoutPrompt,
} from '../public/js/tools/classroom-layout.js';

test('classroom templates generate grouped pair and triple layouts without crossing aisles', () => {
  const pairs = createClassroomLayout({ rows: 2, cols: 6, template: 'pairs' });
  const triples = createClassroomLayout({ rows: 2, cols: 6, template: 'triples' });

  assert.equal(getLayoutCapacity(pairs), 12);
  assert.deepEqual(getLayoutGroups(pairs).map(g => g.seats.length), [2, 2, 2, 2, 2, 2]);
  assert.equal(pairs.groupSize, 2);

  assert.equal(getLayoutCapacity(triples), 12);
  assert.deepEqual(getLayoutGroups(triples).map(g => g.seats.length), [3, 3, 3, 3]);
  assert.equal(triples.groupSize, 3);
});

test('center and horizontal aisle templates expose legacy aisle indexes', () => {
  const center = createClassroomLayout({ rows: 4, cols: 7, template: 'center-aisle' });
  const horizontal = createClassroomLayout({ rows: 5, cols: 6, template: 'horizontal-aisle' });

  assert.deepEqual(layoutToLegacyAisles(center), { rowAisles: [], colAisles: [3] });
  assert.deepEqual(layoutToLegacyAisles(horizontal), { rowAisles: [2], colAisles: [] });
  assert.equal(getLayoutCapacity(center), 24);
  assert.equal(getLayoutCapacity(horizontal), 24);
});

test('grouped layouts do not assign a group across an aisle', () => {
  const layout = createClassroomLayout({ rows: 2, cols: 7, template: 'center-aisle', groupSize: 3 });
  const aisleCol = layoutToLegacyAisles(layout).colAisles[0];

  for (const group of getLayoutGroups(layout)) {
    const cols = group.seats.map(seat => seat.c);
    assert.equal(cols.includes(aisleCol), false);
    assert.ok(Math.max(...cols) < aisleCol || Math.min(...cols) > aisleCol);
  }
});

test('islands template creates realistic empty gaps and four-seat groups', () => {
  const layout = createClassroomLayout({ rows: 4, cols: 6, template: 'islands' });
  const groups = getLayoutGroups(layout);

  assert.equal(layout.cells[0][2], 'aisle');
  assert.equal(layout.cells[2][0], 'aisle');
  assert.ok(groups.length > 0);
  assert.ok(groups.every(group => group.seats.length <= 4));
});

test('guardian seats are optional special capacity', () => {
  const disabled = createClassroomLayout({ rows: 2, cols: 2, template: 'standard', guardiansEnabled: false });
  const enabled = createClassroomLayout({ rows: 2, cols: 2, template: 'standard', guardiansEnabled: true });

  assert.equal(getLayoutCapacity(disabled), 4);
  assert.equal(getLayoutCapacity(enabled), 6);
  assert.deepEqual(enabled.guardians, { enabled: true, left: null, right: null });
});

test('natural language prompt selects template, group size, and guardians', () => {
  assert.deepEqual(parseClassroomLayoutPrompt('三个人一组，中间一条竖过道，开启左右护法'), {
    template: 'center-aisle',
    groupSize: 3,
    guardiansEnabled: true,
  });

  assert.deepEqual(parseClassroomLayoutPrompt('考试单人单座，加一条横过道'), {
    template: 'horizontal-aisle',
    groupSize: 1,
    guardiansEnabled: false,
  });

  assert.deepEqual(parseClassroomLayoutPrompt('三人一组，中间过道，护法关闭'), {
    template: 'center-aisle',
    groupSize: 3,
    guardiansEnabled: false,
  });
});

test('AI layout matrix is validated and converted to standard classroom layout', () => {
  const layout = applyAiLayoutMatrix({
    rows: 2,
    cols: 3,
    matrix: [
      [1, 0, 1],
      [1, 1, 0],
    ],
    groupSize: 2,
    guardiansEnabled: true,
  });

  assert.equal(layout.template, 'custom');
  assert.deepEqual(layout.cells, [
    ['seat', 'aisle', 'seat'],
    ['seat', 'seat', 'aisle'],
  ]);
  assert.equal(getLayoutCapacity(layout), 6);

  assert.throws(() => applyAiLayoutMatrix({ rows: 2, cols: 3, matrix: [[1, 1, 1]] }), /尺寸/);
  assert.throws(() => applyAiLayoutMatrix({ rows: 1, cols: 2, matrix: [[1, 2]] }), /只能包含/);
});
