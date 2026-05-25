import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyGeoGebraProblem,
  extractGeoGebraFacts,
  tryCreateGeoGebraProblemPlan,
} from '../services/geogebra/problem-types.js';

test('GeoGebra problem classifier identifies locus and analytic geometry requests', () => {
  const classification = classifyGeoGebraProblem('已知圆C是以C(0,3)为圆心、3为半径的圆。过原点O作圆C的任意弦OP,求OP的中点M的轨迹方程。');

  assert.equal(classification.primaryType, 'locus');
  assert.ok(classification.types.includes('analytic_geometry'));
  assert.ok(classification.confidence >= 0.8);
});

test('GeoGebra fact extraction keeps exact circle center and radius', () => {
  const facts = extractGeoGebraFacts('已知圆C是以C(0,3)为圆心、3为半径的圆。');

  assert.deepEqual(facts.points.C, { x: 0, y: 3 });
  assert.equal(facts.circles[0].centerLabel, 'C');
  assert.equal(facts.circles[0].radius, 3);
});

test('GeoGebra deterministic template draws circle chord midpoint locus exactly', () => {
  const plan = tryCreateGeoGebraProblemPlan({
    message: '已知圆C是以C(0,3)为圆心、3为半径的圆。过原点O作圆C的任意弦OP,求OP的中点M的轨迹方程。',
  });

  assert.equal(plan.deterministic, true);
  assert.equal(plan.problemType, 'locus');
  assert.match(plan.summary, /x\^2 \+ \(y - 1\.5\)\^2 = 2\.25/);
  assert.ok(plan.commands.includes('O = (0, 0)'));
  assert.ok(plan.commands.includes('C = (0, 3)'));
  assert.ok(plan.commands.includes('c = Circle(C, 3)'));
  assert.ok(plan.commands.includes('M = Midpoint(O, P)'));
});

test('GeoGebra problem templates cover common geometry families without guessing unknowns', () => {
  assert.equal(tryCreateGeoGebraProblemPlan({ message: '画三角形ABC的外接圆' }).problemType, 'triangle_circumcircle');
  assert.equal(tryCreateGeoGebraProblemPlan({ message: '画三角形ABC的内切圆' }).problemType, 'triangle_incircle');
  assert.equal(tryCreateGeoGebraProblemPlan({ message: '画函数 y=x^2-1 的图像' }).problemType, 'function_graph');
  assert.equal(tryCreateGeoGebraProblemPlan({ message: '随便帮我画一个好看的图' }), null);
});
