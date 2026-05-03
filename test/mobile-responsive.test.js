import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appPath = new URL('../public/js/app.js', import.meta.url);
const indexPath = new URL('../public/index.html', import.meta.url);
const mobileStylePath = new URL('../public/css/mobile.css', import.meta.url);
const toolsStylePath = new URL('../public/css/tools.css', import.meta.url);
const seatingSourcePath = new URL('../public/js/tools/seating-planner.js', import.meta.url);
const seatingStylePath = new URL('../public/css/seating-planner.css', import.meta.url);

test('global mobile shell has viewport state, safe tool chrome, and main mode safeguards', async () => {
  const appSource = await readFile(appPath, 'utf8');
  const indexSource = await readFile(indexPath, 'utf8');
  const mobileStyles = await readFile(mobileStylePath, 'utf8');
  const toolStyles = await readFile(toolsStylePath, 'utf8');

  assert.match(indexSource, /viewport-fit=cover/);
  assert.match(appSource, /_syncMobileViewportState/);
  assert.match(appSource, /is-mobile-viewport/);
  assert.match(appSource, /visualViewport/);

  assert.match(mobileStyles, /@media \(max-width: 767px\)/);
  assert.match(mobileStyles, /\.input-area\s*{[^}]*padding-bottom: calc\(12px \+ env\(safe-area-inset-bottom\)\)/s);
  assert.match(mobileStyles, /\.mode-switcher\s*{[^}]*overflow-x: auto/s);
  assert.match(mobileStyles, /\.message-content\s+pre/);
  assert.match(mobileStyles, /\.context-panel\s*{[^}]*max-height: calc\(100dvh - 24px\)/s);

  assert.match(toolStyles, /@media \(max-width: 767px\)/);
  assert.match(toolStyles, /\.tool-container\.active\s*{[^}]*height: 100dvh/s);
  assert.match(toolStyles, /\.tool-body\s*{[^}]*height: calc\(100dvh - var\(--tool-header-height-mobile\)\)/s);
  assert.match(toolStyles, /\.tool-title-text/);
  assert.match(toolStyles, /\.tool-header-actions\s*{[^}]*flex-shrink: 0/s);
});

test('seating planner exposes mobile-first panel tabs, touch seat actions, and assistant layout', async () => {
  const seatingSource = await readFile(seatingSourcePath, 'utf8');
  const seatingStyles = await readFile(seatingStylePath, 'utf8');

  assert.match(seatingSource, /selectedSeatForTouch/);
  assert.match(seatingSource, /mobilePanel/);
  assert.match(seatingSource, /isMobileViewport/);
  assert.match(seatingSource, /syncMobileViewportLayout/);
  assert.match(seatingSource, /setMobilePanel/);
  assert.match(seatingSource, /handleSeatTap/);
  assert.match(seatingSource, /openMobileSeatActions/);
  assert.match(seatingSource, /sp-mobile-panel-tabs/);
  assert.match(seatingSource, /sp-mobile-seat-actions/);

  assert.match(seatingStyles, /@media \(max-width: 767px\)/);
  assert.match(seatingStyles, /\.sp-app--mobile/);
  assert.match(seatingStyles, /\.sp-mobile-panel-tabs/);
  assert.match(seatingStyles, /\.sp-mobile-drawer-toggle/);
  assert.match(seatingStyles, /\.sp-mobile-seat-actions/);
  assert.match(seatingStyles, /\.sp-seat--mobile-selected/);
  assert.match(seatingStyles, /\.sp-chat-panel\s*{[^}]*height: calc\(100dvh - 24px\)/s);
  assert.match(seatingStyles, /\.sp-feedback-panel\s*{[^}]*height: calc\(100dvh - 24px\)/s);
});
