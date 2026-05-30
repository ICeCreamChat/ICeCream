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
const REAL_ANGLE_MAX_PROBLEM = '\u5728\u5e73\u9762\u76f4\u89d2\u5750\u6807\u7cfb\u4e2d\uff0c\u5df2\u77e5\u4e24\u5b9a\u70b9$A(0,2)$\u548c$B(0,6)$\u3002\u5728$x$\u8f74\u7684\u6b63\u534a\u8f74\u4e0a\u786e\u5b9a\u4e00\u70b9$P$\uff0c\u4f7f\u5f97\u9510\u89d2$\\angle APB$\u8fbe\u5230\u6700\u5927\u3002\u6c42\u6b64\u65f6\u70b9$P$\u7684\u5750\u6807\u3002';

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
    type: 'timeline',
    autoPlay: false,
    clearBeforePlay: true,
    preserveAfterFinish: true,
    durationMs: 8000,
    tracks: [{
      kind: 'path-trace',
      movingObject: 'P',
      tracedObject: 'M',
      samples: 240,
      path: {
        type: 'circle',
        center: { x: 0, y: 3 },
        radius: 3,
        startAngle: -90,
        endAngle: 270,
      },
    }],
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
    assert.equal(plan.demo?.type, 'timeline');
    assert.equal(plan.demo?.autoPlay, false);
    assert.equal(plan.demo?.tracks?.[0]?.kind, 'path-trace');
    assert.equal(plan.demo?.tracks?.[0]?.samples, 240);
    assert.equal(plan.demo?.tracks?.[0]?.path?.type, 'circle');
    assert.deepEqual(plan.demo?.tracks?.[0]?.path?.center, { x: 0, y: 3 });
    assert.equal(plan.demo?.tracks?.[0]?.path?.radius, 3);
  }
});

test('GeoGebra deterministic template handles positive x-axis maximum angle problems', () => {
  const facts = extractGeoGebraFacts(REAL_ANGLE_MAX_PROBLEM);
  const plan = tryCreateGeoGebraProblemPlan({ message: REAL_ANGLE_MAX_PROBLEM });

  assert.deepEqual(facts.points.A, { x: 0, y: 2 });
  assert.deepEqual(facts.points.B, { x: 0, y: 6 });
  assert.equal(plan.deterministic, true);
  assert.equal(plan.problemType, 'angle_max_on_positive_x_axis');
  assert.match(plan.summary, /P = \(2√3, 0\)/);
  assert.ok(plan.commands.includes('A = (0, 2)'));
  assert.ok(plan.commands.includes('B = (0, 6)'));
  assert.ok(plan.commands.includes('P = (sqrt(12), 0)'));
  assert.ok(plan.commands.includes('angP = Angle(B, P, A)'));
  assert.ok(Array.isArray(plan.constructionPlan));
  assert.equal(plan.viewport?.equalScale, true);
  assert.equal(plan.demo?.type, 'timeline');
  assert.equal(plan.demo?.autoPlay, false);
  assert.equal(plan.demo?.tracks?.[0]?.kind, 'move-point');
  assert.equal(plan.demo?.tracks?.[0]?.movingObject, 'Q');
  assert.equal(plan.demo?.tracks?.[0]?.path?.type, 'polyline');
  assert.deepEqual(plan.demo?.tracks?.[0]?.path?.points?.at(-1), { x: 3.464102, y: 0 });
  assert.equal(plan.validation?.angles?.[0]?.object, 'angP');
});

test('GeoGebra problem templates cover common geometry families without guessing unknowns', () => {
  assert.equal(tryCreateGeoGebraProblemPlan({ message: '画三角形ABC的外接圆' }).problemType, 'triangle_circumcircle');
  assert.equal(tryCreateGeoGebraProblemPlan({ message: '画三角形ABC的内切圆' }).problemType, 'triangle_incircle');
  assert.equal(tryCreateGeoGebraProblemPlan({ message: '画函数 y=x^2-1 的图像' }).problemType, 'function_graph');
  assert.equal(tryCreateGeoGebraProblemPlan({ message: '随便帮我画一个好看的图' }), null);
});
