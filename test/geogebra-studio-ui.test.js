import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const studioPath = new URL('../public/js/core/geogebra-studio.js', import.meta.url);
const workbenchPath = new URL('../public/js/core/geogebra-workbench.js', import.meta.url);
const canvasPath = new URL('../public/js/core/geogebra-canvas.js', import.meta.url);
const mainStylesPath = new URL('../public/css/main.css', import.meta.url);
const mobileStylesPath = new URL('../public/css/mobile.css', import.meta.url);

test('GeoGebra Studio exposes a maintainable adjustment workbench', async () => {
  const [studioSource, workbenchSource, mainStyles, mobileStyles] = await Promise.all([
    readFile(studioPath, 'utf8'),
    readFile(workbenchPath, 'utf8'),
    readFile(mainStylesPath, 'utf8'),
    readFile(mobileStylesPath, 'utf8'),
  ]);

  assert.match(workbenchSource, /geogebraStudio/);
  assert.match(workbenchSource, /geogebraStudio\.render/);
  assert.match(workbenchSource, /geogebraStudio\.bind/);

  assert.match(studioSource, /GEOGEBRA_STUDIO_SESSION_KEY/);
  assert.match(studioSource, /icecream_geogebra_studio_v1/);
  assert.match(studioSource, /\/api\/geogebra\/studio\/adjust/);
  assert.match(studioSource, /GEOGEBRA_STUDIO_TABS = \['objects', 'adjust', 'commands', 'history'\]/);
  assert.match(studioSource, /renderTab\('objects'/);
  assert.match(studioSource, /renderTab\('adjust'/);
  assert.match(studioSource, /renderTab\('commands'/);
  assert.match(studioSource, /renderTab\('history'/);
  assert.match(studioSource, /data-geogebra-studio-action="undo"/);
  assert.match(studioSource, /data-geogebra-studio-action="redo"/);
  assert.match(studioSource, /data-geogebra-studio-action="export"/);
  assert.match(studioSource, /runStudioAdjustment/);
  assert.match(studioSource, /executeManualCommands/);
  assert.match(studioSource, /selectObject/);

  assert.match(mainStyles, /\.geogebra-studio-layout/);
  assert.match(mainStyles, /\.geogebra-studio-sidebar/);
  assert.match(mainStyles, /\.geogebra-studio-object-list/);
  assert.match(mainStyles, /\.geogebra-studio-command-editor/);
  assert.match(mobileStyles, /\.geogebra-studio-layout/);
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
