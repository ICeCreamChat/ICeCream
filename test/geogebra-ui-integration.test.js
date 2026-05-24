import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appPath = new URL('../public/js/app.js', import.meta.url);
const canvasPath = new URL('../public/js/core/geogebra-canvas.js', import.meta.url);
const constantsPath = new URL('../public/js/constants.js', import.meta.url);
const messageHandlerPath = new URL('../public/js/core/message-handler.js', import.meta.url);
const workbenchPath = new URL('../public/js/core/manim-workbench.js', import.meta.url);
const geogebraWorkbenchPath = new URL('../public/js/core/geogebra-workbench.js', import.meta.url);
const indexPath = new URL('../public/index.html', import.meta.url);
const mainStylesPath = new URL('../public/css/main.css', import.meta.url);
const mobileStylesPath = new URL('../public/css/mobile.css', import.meta.url);

test('GeoGebra frontend modules use local vendor assets and explicit APIs', async () => {
  const [canvasSource, geogebraWorkbenchSource] = await Promise.all([
    readFile(canvasPath, 'utf8'),
    readFile(geogebraWorkbenchPath, 'utf8'),
  ]);

  assert.match(canvasSource, /\/vendor\/geogebra\/deployggb\.js/);
  assert.match(canvasSource, /setHTML5Codebase\('\/vendor\/geogebra\/HTML5\/5\.0\/web3d\/'\)/);
  assert.match(canvasSource, /asyncEvalCommandGetLabels|evalCommand/);
  assert.match(canvasSource, /getXML/);

  assert.match(geogebraWorkbenchSource, /\/api\/geogebra\/plan/);
  assert.match(geogebraWorkbenchSource, /\/api\/geogebra\/repair/);
  assert.match(geogebraWorkbenchSource, /geogebra-command-history/);
});

test('Animation workbench exposes Manim and GeoGebra as parallel submodes', async () => {
  const [appSource, constantsSource, messageHandlerSource, workbenchSource, htmlSource, mainStyles, mobileStyles] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(constantsPath, 'utf8'),
    readFile(messageHandlerPath, 'utf8'),
    readFile(workbenchPath, 'utf8'),
    readFile(indexPath, 'utf8'),
    readFile(mainStylesPath, 'utf8'),
    readFile(mobileStylesPath, 'utf8'),
  ]);

  assert.match(workbenchSource, /icecream_animation_engine_v1/);
  assert.match(workbenchSource, /GeoGebra 动态几何/);
  assert.match(workbenchSource, /Manim 视频动画/);
  assert.match(workbenchSource, /geogebraWorkbench/);

  assert.match(messageHandlerSource, /runGeoGebraPlan/);
  assert.match(messageHandlerSource, /looksLikeGeoGebraRequest/);
  assert.match(messageHandlerSource, /getAnimationEngine/);
  assert.match(messageHandlerSource, /refreshVisiblePanel/);

  assert.match(appSource, /setAnimationEngine/);
  assert.match(constantsSource, /GeoGebra/);
  assert.match(htmlSource, /自然语言描述，生成 Manim 动画或 GeoGebra 动态几何/);
  assert.match(mainStyles, /\.animation-engine-switch/);
  assert.match(mainStyles, /\.geogebra-canvas-root/);
  assert.match(mobileStyles, /\.geogebra-canvas-root/);
});
