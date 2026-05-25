import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const studioPath = new URL('../public/js/core/geogebra-studio.js', import.meta.url);
const workbenchPath = new URL('../public/js/core/geogebra-workbench.js', import.meta.url);
const studioShellPath = new URL('../public/js/core/geogebra-studio-shell.js', import.meta.url);
const canvasPath = new URL('../public/js/core/geogebra-canvas.js', import.meta.url);
const mainStylesPath = new URL('../public/css/main.css', import.meta.url);
const mobileStylesPath = new URL('../public/css/mobile.css', import.meta.url);

test('GeoGebra Studio exposes a maintainable adjustment workbench', async () => {
  const [studioSource, workbenchSource, studioShellSource, mainStyles, mobileStyles] = await Promise.all([
    readFile(studioPath, 'utf8'),
    readFile(workbenchPath, 'utf8'),
    readFile(studioShellPath, 'utf8'),
    readFile(mainStylesPath, 'utf8'),
    readFile(mobileStylesPath, 'utf8'),
  ]);

  assert.match(workbenchSource, /geogebraStudio/);
  assert.match(workbenchSource, /geogebraStudio\.render/);
  assert.match(workbenchSource, /geogebraStudio\.bind/);
  assert.match(studioShellSource, /GeoGebraStudioShell/);
  assert.match(studioShellSource, /geogebra-studio-shell/);
  assert.match(studioShellSource, /geogebraWorkbench\.prepare/);

  assert.match(studioSource, /GEOGEBRA_STUDIO_SESSION_KEY/);
  assert.match(studioSource, /icecream_geogebra_studio_v1/);
  assert.match(studioSource, /\/api\/geogebra\/studio\/adjust/);
  assert.match(studioSource, /\/api\/geogebra\/studio\/parse-image/);
  assert.match(studioSource, /GEOGEBRA_STUDIO_TABS = \['objects', 'adjust', 'commands', 'manual', 'projects', 'history'\]/);
  assert.match(studioSource, /renderTab\('objects'/);
  assert.match(studioSource, /renderTab\('adjust'/);
  assert.match(studioSource, /renderTab\('commands'/);
  assert.match(studioSource, /renderTab\('manual'/);
  assert.match(studioSource, /renderTab\('projects'/);
  assert.match(studioSource, /renderTab\('history'/);
  assert.match(studioSource, /data-geogebra-studio-action="undo"/);
  assert.match(studioSource, /data-geogebra-studio-action="redo"/);
  assert.match(studioSource, /data-geogebra-studio-action="export"/);
  assert.match(studioSource, /data-geogebra-studio-action="upload-problem"/);
  assert.match(studioSource, /data-geogebra-studio-action="retry-problem-image"/);
  assert.match(studioSource, /parseProblemImage/);
  assert.match(studioSource, /data-geogebra-canvas-loading/);
  assert.match(studioSource, /data-geogebra-canvas-error/);
  assert.match(studioSource, /data-geogebra-studio-action="retry-canvas"/);
  assert.match(studioSource, /正在加载 GeoGebra 离线画布/);
  assert.match(studioSource, /重试加载/);
  assert.match(studioSource, /canvasMountPromise/);
  assert.match(studioSource, /needsCanvasMount/);
  assert.match(studioSource, /isCanvasDomReady/);
  assert.match(studioSource, /forceRebuild:\s*domWasReplaced/);
  assert.match(studioSource, /restoreSnapshot:\s*domWasReplaced/);
  assert.match(studioSource, /runStudioAdjustment/);
  assert.match(studioSource, /executeManualCommands/);
  assert.match(studioSource, /selectObject/);

  assert.match(mainStyles, /\.geogebra-studio-layout/);
  assert.match(mainStyles, /\.geogebra-studio-shell/);
  assert.match(mainStyles, /\.geogebra-problem-upload/);
  assert.match(mainStyles, /\.geogebra-studio-sidebar/);
  assert.match(mainStyles, /\.geogebra-studio-object-list/);
  assert.match(mainStyles, /\.geogebra-studio-command-editor/);
  assert.match(mobileStyles, /\.geogebra-studio-layout/);
  assert.match(mobileStyles, /\.geogebra-studio-shell/);
});

test('GeoGebra canvas supports Studio snapshots without replacing existing APIs', async () => {
  const canvasSource = await readFile(canvasPath, 'utf8');

  assert.match(canvasSource, /captureSnapshot/);
  assert.match(canvasSource, /restoreSnapshot/);
  assert.match(canvasSource, /setXML/);
  assert.match(canvasSource, /executeCommands/);
  assert.match(canvasSource, /readCanvas/);
  assert.match(canvasSource, /exportPngBase64/);
});

test('GeoGebra canvas uses reference-style applet boot and resize handling', async () => {
  const canvasSource = await readFile(canvasPath, 'utf8');

  assert.match(canvasSource, /window\.ggbAppletReady/);
  assert.match(canvasSource, /window\.ggbApplet/);
  assert.match(canvasSource, /width:\s*'100%'/);
  assert.match(canvasSource, /height:\s*'100%'/);
  assert.match(canvasSource, /showMenuBar:\s*true/);
  assert.match(canvasSource, /showAlgebraInput:\s*false/);
  assert.match(canvasSource, /enable3d:\s*true/);
  assert.match(canvasSource, /enableUndoRedo:\s*true/);
  assert.match(canvasSource, /scaleContainerClass:\s*'geogebra-canvas-root'/);
  assert.match(canvasSource, /ResizeObserver/);
  assert.match(canvasSource, /case 'select'/);
  assert.match(canvasSource, /case 'deselect'/);
});
