import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const studioPath = new URL('../public/js/core/geogebra-studio.js', import.meta.url);
const studioViewPath = new URL('../public/js/core/geogebra-studio-view.js', import.meta.url);

test('GeoGebra Studio exposes manual reference and project draft panels', async () => {
  const studioSource = await readFile(studioPath, 'utf8');

  assert.match(studioSource, /manual/);
  assert.match(studioSource, /projects/);
  assert.match(studioSource, /\/api\/geogebra\/manual\/search/);
  assert.match(studioSource, /searchManualReference/);
  assert.match(studioSource, /saveCurrentProjectPage/);
  assert.match(studioSource, /loadProjectPage/);
  assert.match(studioSource, /exportGgb/);
});

test('GeoGebra Studio uploads problem images and draws them through the presentation assistant', async () => {
  const [studioSource, studioViewSource] = await Promise.all([
    readFile(studioPath, 'utf8'),
    readFile(studioViewPath, 'utf8'),
  ]);

  assert.match(studioSource, /pendingProblemPlan/);
  assert.match(studioSource, /problemReviewText/);
  assert.match(studioViewSource, /data-geogebra-prompt-input/);
  assert.match(studioSource, /executeUploadedProblemPlan/);
  assert.match(studioSource, /parseProblemImage[\s\S]*await this\.executeUploadedProblemPlan/);
  assert.match(studioViewSource, /data-geogebra-studio-action="draw-from-prompt"/);
  assert.match(studioViewSource, /data-geogebra-studio-action="redraw-from-prompt"/);
  assert.doesNotMatch(studioSource, /data-geogebra-problem-review-input/);
  assert.doesNotMatch(studioSource, /data-geogebra-studio-action="draw-problem-plan"/);
  assert.doesNotMatch(studioSource, /data-geogebra-studio-action="replan-problem-text"/);
  assert.doesNotMatch(studioSource, /const outcome = await this\.executePlanCommands\(body,\s*\{\s*source: 'image_parse'/);
});
