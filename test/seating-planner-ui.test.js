import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourcePath = new URL('../public/js/tools/seating-planner.js', import.meta.url);

test('seating planner exposes AI requirement entry instead of fixed layout controls', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /sp-arrange-prompt/);
  assert.match(source, /\/api\/tools\/seating\/arrange/);
  assert.doesNotMatch(source, /data-layout-template=/);
  assert.doesNotMatch(source, /id="sp-rows"/);
  assert.doesNotMatch(source, /id="sp-cols"/);
  assert.doesNotMatch(source, /sp-layout-prompt/);
});

test('seating planner has a large-grid virtual rendering guard', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /VIRTUAL_GRID_CELL_THRESHOLD/);
  assert.match(source, /renderVirtualGrid/);
  assert.match(source, /sp-grid--virtual/);
});

test('seating planner shows clearer strategy labels and applied strategy status', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /搭配偏好/);
  assert.match(source, /身高照顾/);
  assert.match(source, /优秀优先/);
  assert.match(source, /appliedStrategies/);
});

test('seating planner can show and hide seat grade and height details', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /showSeatDetails/);
  assert.match(source, /sp-toggle-seat-details/);
  assert.match(source, /sp-seat-meta/);
  assert.match(source, /renderSeatMeta/);
});

test('seating planner marks books by top 20 percent grades instead of fixed score', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /getTopGradeStudentIds/);
  assert.match(source, /isTopGradeStudent/);
  assert.match(source, /Math\.ceil\(ranked\.length \* 0\.2\)/);
  assert.doesNotMatch(source, /student\.grade\s*&&\s*student\.grade\s*>=\s*90/);
  assert.doesNotMatch(source, /grade\s*>=\s*90/);
});

test('seating planner grade priority places only top 20 percent into best scored seats', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /placeTopGradeStudentsInBestSeats/);
  assert.match(source, /sortSeatsByScore/);
  assert.match(source, /getTopGradeStudentIds/);
  assert.match(source, /globalColumnCenter/);
  assert.doesNotMatch(source, /Grade priority: higher grade first/);
  assert.match(source, /height decides row, top 20% gets center seats inside that row/);
});

test('seating planner does not show arrangement notes as a second success warning toast', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /showArrangementWarnings/);
  assert.doesNotMatch(source, /if \(arrangement\.warnings\.length\) this\.showToast\(arrangement\.warnings\.join\('；'\), 'warning'\)/);
});
