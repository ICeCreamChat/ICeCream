import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appPath = new URL('../public/js/app.js', import.meta.url);
const indexPath = new URL('../public/index.html', import.meta.url);
const mobileStylePath = new URL('../public/css/mobile.css', import.meta.url);
const toolsStylePath = new URL('../public/css/tools.css', import.meta.url);
const seatingSourcePath = new URL('../public/js/tools/seating-planner.js', import.meta.url);
const seatingStylePath = new URL('../public/css/seating-planner.css', import.meta.url);

test('global mobile shell keeps viewport, mobile nav behavior, and resilient theme persistence', async () => {
  const appSource = await readFile(appPath, 'utf8');
  const indexSource = await readFile(indexPath, 'utf8');
  const mobileStyles = await readFile(mobileStylePath, 'utf8');
  const toolStyles = await readFile(toolsStylePath, 'utf8');

  assert.match(indexSource, /viewport-fit=cover/);

  assert.match(appSource, /mobileMenuBtn\?\.addEventListener\('click', \(\) => this\._toggleSidebar\(\)\)/);
  assert.match(appSource, /sidebarOverlay\?\.addEventListener\('click', \(\) => this\._closeSidebar\(\)\)/);
  assert.match(appSource, /_toggleSidebar\(\)\s*{[^}]*classList\.toggle\('open'\)[^}]*classList\.toggle\('active'\)/s);
  assert.match(appSource, /try\s*{\s*savedTheme = localStorage\.getItem\('theme'\);\s*}/s);
  assert.match(appSource, /try\s*{\s*localStorage\.setItem\('theme', isLight \? 'light' : 'dark'\);\s*}/s);

  assert.match(mobileStyles, /@media \(max-width: 767px\)/);
  assert.match(mobileStyles, /\.input-area\s*{[^}]*padding-bottom: calc\(12px \+ env\(safe-area-inset-bottom, 0\)\)/s);
  assert.match(mobileStyles, /\.mode-switcher\s*{[^}]*overflow-x: auto/s);
  assert.match(mobileStyles, /\.message-content\s*{/);
  assert.match(mobileStyles, /\.code-panel \.mobile-panel-tabs/);

  assert.match(toolStyles, /\.tool-container\.active/);
  assert.match(toolStyles, /\.tool-body\s*{[^}]*height: calc\(100vh - 65px\)/s);
  assert.match(toolStyles, /\.tool-header-actions\s*{/);
  assert.match(toolStyles, /@media \(max-width: 480px\)/);
  assert.match(toolStyles, /\.tool-ai-status-label[\s\S]*display: none/);
});

test('seating planner keeps touch interactions and draggable floating assistant affordances', async () => {
  const seatingSource = await readFile(seatingSourcePath, 'utf8');
  const seatingStyles = await readFile(seatingStylePath, 'utf8');

  assert.match(seatingSource, /id="sp-chat-toggle"/);
  assert.match(seatingSource, /id="sp-chat-panel"/);
  assert.match(seatingSource, /id="sp-chat-header"/);
  assert.match(seatingSource, /id="sp-chat-input"/);
  assert.match(seatingSource, /CHAT_DRAG_THRESHOLD/);
  assert.match(seatingSource, /window\.addEventListener\('pointermove', this\._chatPointerMoveHandler\)/);
  assert.match(seatingSource, /window\.addEventListener\('pointermove', this\._chatIconPointerMoveHandler\)/);
  assert.match(seatingSource, /blackboard\.addEventListener\('touchstart', onPointerDown, \{ passive: false \}\)/);
  assert.match(seatingSource, /sp-feedback-panel/);

  assert.match(seatingStyles, /\.sp-chat-panel\s*{[^}]*max-height: min\(480px, calc\(100vh - 24px\)\)/s);
  assert.match(seatingStyles, /\.sp-chat--positioned/);
  assert.match(seatingStyles, /\.sp-chat--dragging \.sp-chat-header/);
  assert.match(seatingStyles, /\.sp-feedback-panel/);
  assert.match(seatingStyles, /@media \(max-width: 520px\)/);
  assert.match(seatingStyles, /@media \(max-width: 768px\)/);
});

test('seating planner status bar stays compact and wraps on narrow screens', async () => {
  const seatingStyles = await readFile(seatingStylePath, 'utf8');
  const statusStart = seatingStyles.indexOf('@media (max-width: 768px)', seatingStyles.indexOf('.sp-status-warning-chip'));
  const statusEnd = seatingStyles.indexOf('.sp-arrangement-explain', statusStart);
  const statusMedia = seatingStyles.slice(statusStart, statusEnd);

  assert.match(statusMedia, /@media \(max-width: 768px\)/);
  assert.match(statusMedia, /\.sp-status\s*{[^}]*flex-wrap:\s*wrap/s);
  assert.match(statusMedia, /\.sp-status-left\s*{[^}]*flex:\s*1 1 100%/s);
  assert.match(statusMedia, /\.sp-status-middle\s*{[^}]*flex:\s*1 1 auto/s);
  assert.match(statusMedia, /\.sp-status-right\s*{[^}]*margin-left:\s*auto/s);
  assert.doesNotMatch(statusMedia, /grid-template-areas/);
});
