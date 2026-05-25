import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyGeoGebraProblem,
  extractGeoGebraFacts,
  tryCreateGeoGebraProblemPlan,
} from '../services/geogebra/problem-types.js';

const REAL_LOCUS_PROBLEM = '\u5df2\u77e5\u5706C\u662f\u4ee5C(0,3)\u4e3a\u5706\u5fc3\u30013\u4e3a\u534a\u5f84\u7684\u5706\u3002\u8fc7\u539f\u70b9O\u4f5c\u5706C\u7684\u4efb\u610f\u5f26OP,\u6c42OP\u7684\u4e2d\u70b9M\u7684\u8f68\u8ff9\u65b9\u7a0b\u3002';
const REAL_LOCUS_PROBLEM_WITH_LATEX_ORIGIN = '\u3010\u4f8b1\u3011\u3001\u5df2\u77e5\u5706C\u662f\u4ee5C(0,3)\u4e3a\u5706\u5fc3\u30013\u4e3a\u534a\u5f84\u7684\u5706\u3002\u8fc7\u539f\u70b9$O$\u4f5c\u5706C\u7684\u4efb\u610f\u5f26OP,\u6c42OP\u7684\u4e2d\u70b9M\u7684\u8f68\u8ff9\u65b9\u7a0b\u3002';
const REAL_LOCUS_PROBLEM_WITH_PAREN_ORIGIN = '\u3010\u4f8b1\u3011\u5df2\u77e5\u5706C\u662f\u4ee5C(0,3)\u4e3a\u5706\u5fc3\uff0c3\u4e3a\u534a\u5f84\u7684\u5706\u3002\u8fc7\u539f\u70b9\\(O\\)\u4f5c\u5706C\u7684\u4efb\u610f\u5f26OP\uff0c\u6c42OP\u7684\u4e2d\u70b9M\u7684\u8f68\u8ff9\u65b9\u7a0b\u3002';

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
  assert.deepEqual(plan.viewport, {
    xmin: -4,
    ymin: -1,
    xmax: 4,
    ymax: 7,
    equalScale: true,
  });
  assert.deepEqual(plan.demo, {
    type: 'trace',
    autoPlay: true,
    movingObject: 'P',
    tracedObject: 'M',
    durationMs: 6500,
    frameCount: 96,
    path: {
      type: 'circle',
      center: { x: 0, y: 3 },
      radius: 3,
      startAngle: -90,
      endAngle: 270,
    },
  });
  assert.equal(plan.commands.some(command => /^ZoomIn\(/.test(command)), false);
  assert.equal(plan.commands.some(command => /^StartAnimation\(/.test(command)), false);
  assert.equal(plan.commands.some(command => /^SetTrace\(/.test(command)), false);
});

test('GeoGebra deterministic template handles real OCR text with LaTeX origin markers', () => {
  for (const message of [REAL_LOCUS_PROBLEM, REAL_LOCUS_PROBLEM_WITH_LATEX_ORIGIN, REAL_LOCUS_PROBLEM_WITH_PAREN_ORIGIN]) {
    const facts = extractGeoGebraFacts(message);
    const plan = tryCreateGeoGebraProblemPlan({ message });

    assert.deepEqual(facts.points.O, { x: 0, y: 0 });
    assert.equal(facts.circles[0].centerLabel, 'C');
    assert.equal(facts.circles[0].radius, 3);
    assert.equal(plan.deterministic, true);
    assert.equal(plan.problemType, 'locus');
    assert.match(plan.summary, /x\^2 \+ \(y - 1\.5\)\^2 = 2\.25/);
    assert.ok(plan.commands.includes('K = (0, 1.5)'));
    assert.ok(plan.commands.includes('locusM = Circle(K, 1.5)'));
    assert.equal(plan.viewport?.equalScale, true);
    assert.equal(plan.demo?.type, 'trace');
    assert.equal(plan.demo?.autoPlay, true);
    assert.equal(plan.demo?.path?.type, 'circle');
    assert.deepEqual(plan.demo?.path?.center, { x: 0, y: 3 });
    assert.equal(plan.demo?.path?.radius, 3);
  }
});

test('GeoGebra problem templates cover common geometry families without guessing unknowns', () => {
  assert.equal(tryCreateGeoGebraProblemPlan({ message: '画三角形ABC的外接圆' }).problemType, 'triangle_circumcircle');
  assert.equal(tryCreateGeoGebraProblemPlan({ message: '画三角形ABC的内切圆' }).problemType, 'triangle_incircle');
  assert.equal(tryCreateGeoGebraProblemPlan({ message: '画函数 y=x^2-1 的图像' }).problemType, 'function_graph');
  assert.equal(tryCreateGeoGebraProblemPlan({ message: '随便帮我画一个好看的图' }), null);
});
