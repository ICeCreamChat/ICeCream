import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectPlanObjectReferences,
  runGeoGebraAutomatedCheck,
} from '../public/js/core/geogebra-automated-check.js';

test('GeoGebra automated check passes a valid construction timeline plan', () => {
  const demo = {
    type: 'timeline',
    mode: 'construction',
    initialState: { visible: ['O', 'C', 'c'], hidden: ['P', 'M', 'locusM'] },
    stages: [
      { id: 'known', actions: [{ kind: 'set-visible', objects: ['O', 'C', 'c'], visible: true }] },
      {
        id: 'observe',
        actions: [{
          kind: 'path-trace',
          movingObject: 'P',
          tracedObject: 'M',
          path: { type: 'circle', center: { x: 0, y: 3 }, radius: 3 },
        }],
      },
    ],
  };

  const result = runGeoGebraAutomatedCheck({
    planBody: {
      commands: [
        'O = (0, 0)',
        'C = (0, 3)',
        'c = Circle(C, 3)',
        'P = Point(c)',
        'M = Midpoint(O, P)',
        'locusM = Circle((0, 1.5), 1.5)',
      ],
      viewport: { xmin: -4, ymin: -1, xmax: 4, ymax: 7, equalScale: true },
      demo,
    },
    records: [
      { command: 'O = (0, 0)', success: true },
      { command: 'C = (0, 3)', success: true },
      { command: 'c = Circle(C, 3)', success: true },
      { command: 'P = Point(c)', success: true },
      { command: 'M = Midpoint(O, P)', success: true },
      { command: 'locusM = Circle((0, 1.5), 1.5)', success: true },
    ],
    canvasSnapshot: {
      objects: [
        { name: 'O' },
        { name: 'C' },
        { name: 'c' },
        { name: 'P' },
        { name: 'M' },
        { name: 'locusM' },
      ],
    },
    demoConfig: demo,
    latestViewport: { xmin: -4, ymin: -1, xmax: 4, ymax: 7, equalScale: true },
  });

  assert.equal(result.status, 'passed');
  assert.match(result.summary, /自动化检查通过/);
  assert.ok(result.items.some(item => item.id === 'objects' && item.status === 'passed'));
  assert.ok(result.items.some(item => item.id === 'demo' && item.status === 'passed'));
});

test('GeoGebra automated check reports missing objects and failed commands', () => {
  const result = runGeoGebraAutomatedCheck({
    planBody: {
      commands: ['A = (0, 0)', 'B = (2, 0)', 'segAB = Segment(A, B)'],
      viewport: { equalScale: true },
    },
    records: [
      { command: 'A = (0, 0)', success: true },
      { command: 'B = (2, 0)', success: true },
      { command: 'segAB = Segment(A, B)', success: false, error: 'bad command' },
    ],
    canvasSnapshot: { objects: [{ name: 'A' }] },
    latestViewport: null,
  });

  assert.equal(result.status, 'failed');
  assert.match(result.summary, /自动化检查发现问题/);
  assert.ok(result.items.some(item => item.id === 'commands' && item.status === 'failed'));
  assert.ok(result.items.some(item => item.id === 'objects' && item.status === 'failed'));
  assert.ok(result.items.some(item => item.id === 'viewport' && item.status === 'warning'));
});

test('GeoGebra automated check collects command and demo object references', () => {
  const references = collectPlanObjectReferences({
    commands: ['A = (0,0)', 'lineAB = Line(A, B)', 'SetColor(A, 255, 0, 0)'],
    demo: {
      initialState: { hidden: ['lineAB'] },
      stages: [{ actions: [{ kind: 'path-trace', movingObject: 'P', tracedObject: 'M' }] }],
    },
  });

  assert.deepEqual(references.commandLabels, ['A', 'lineAB']);
  assert.ok(references.demoLabels.includes('P'));
  assert.ok(references.demoLabels.includes('M'));
  assert.ok(references.demoLabels.includes('lineAB'));
});
