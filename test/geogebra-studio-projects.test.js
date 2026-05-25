import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const studioPath = new URL('../public/js/core/geogebra-studio.js', import.meta.url);

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

test('GeoGebra Studio supports OCR review before drawing uploaded problems', async () => {
  const studioSource = await readFile(studioPath, 'utf8');

  assert.match(studioSource, /pendingProblemPlan/);
  assert.match(studioSource, /problemReviewText/);
  assert.match(studioSource, /data-geogebra-prompt-input/);
  assert.match(studioSource, /executeUploadedProblemPlan/);
  assert.match(studioSource, /parseProblemImage[\s\S]*await this\.executeUploadedProblemPlan/);
  assert.match(studioSource, /data-geogebra-studio-action="draw-from-prompt"/);
  assert.match(studioSource, /data-geogebra-studio-action="replan-problem-text"/);
  assert.doesNotMatch(studioSource, /data-geogebra-problem-review-input/);
  assert.doesNotMatch(studioSource, /data-geogebra-studio-action="draw-problem-plan"/);
  assert.doesNotMatch(studioSource, /const outcome = await this\.executePlanCommands\(body,\s*\{\s*source: 'image_parse'/);
});
