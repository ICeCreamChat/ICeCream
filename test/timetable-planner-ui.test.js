import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourcePath = new URL('../public/js/tools/timetable-planner.js', import.meta.url);
const stylePath = new URL('../public/css/timetable-planner.css', import.meta.url);

test('timetable planner uses the seating-style control panel and board layout', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /class="tt-app"/);
  assert.match(source, /class="tt-main"/);
  assert.match(source, /class="tt-panel"/);
  assert.match(source, /class="tt-board"/);
  assert.match(source, /class="tt-board-view"/);
  assert.match(source, /class="tt-status-bar"/);
  assert.match(source, /renderControlPanel/);
  assert.match(source, /renderBoard/);
  assert.match(source, /renderStatusBar/);
  assert.doesNotMatch(source, /class="tt-tabs"/);
  assert.doesNotMatch(source, /renderTab\(/);
  assert.doesNotMatch(source, /renderActiveTab/);

  assert.match(styles, /\.tt-app\s*{/);
  assert.match(styles, /\.tt-main\s*{[^}]*grid-template-columns:\s*320px minmax\(0,\s*1fr\)/s);
  assert.match(styles, /\.tt-panel\s*{[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.tt-board-view\s*{[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.tt-status-bar\s*{/);
  assert.match(styles, /@media \(max-width:\s*900px\)[\s\S]*\.tt-main\s*{[^}]*grid-template-columns:\s*1fr/s);
});

test('timetable planner keeps schedule operations inside the board surface', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /id="tt-run-schedule"/);
  assert.match(source, /id="tt-owner-select"/);
  assert.match(source, /data-view-mode="class"/);
  assert.match(source, /data-view-mode="teacher"/);
  assert.match(source, /data-view-mode="master"/);
  assert.match(source, /id="tt-lock-selected"/);
  assert.match(source, /id="tt-clear-selected"/);
  assert.match(source, /error\.payload = payload/);
  assert.match(source, /previous schedule was kept/);
  assert.match(source, /data-export-type="class"/);
  assert.match(source, /data-export-type="teacher"/);
  assert.match(source, /data-export-type="master"/);
  assert.match(source, /data-export-type="plans"/);
});
