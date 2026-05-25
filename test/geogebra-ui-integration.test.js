import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdir, stat } from 'node:fs/promises';
import test from 'node:test';

const appPath = new URL('../public/js/app.js', import.meta.url);
const animationEntryPath = new URL('../public/js/core/animation-entry-launcher.js', import.meta.url);
const canvasPath = new URL('../public/js/core/geogebra-canvas.js', import.meta.url);
const constantsPath = new URL('../public/js/constants.js', import.meta.url);
const messageHandlerPath = new URL('../public/js/core/message-handler.js', import.meta.url);
const modeSwitcherPath = new URL('../public/js/core/mode-switcher.js', import.meta.url);
const workbenchPath = new URL('../public/js/core/manim-workbench.js', import.meta.url);
const geogebraWorkbenchPath = new URL('../public/js/core/geogebra-workbench.js', import.meta.url);
const geogebraStudioPath = new URL('../public/js/core/geogebra-studio.js', import.meta.url);
const indexPath = new URL('../public/index.html', import.meta.url);
const mainStylesPath = new URL('../public/css/main.css', import.meta.url);
const mobileStylesPath = new URL('../public/css/mobile.css', import.meta.url);
const deployPath = new URL('../public/vendor/geogebra/deployggb.js', import.meta.url);
const web3dPath = new URL('../public/vendor/geogebra/HTML5/5.0/web3d/', import.meta.url);

test('GeoGebra frontend modules use local vendor assets and explicit APIs', async () => {
  const [canvasSource, geogebraWorkbenchSource, geogebraStudioSource] = await Promise.all([
    readFile(canvasPath, 'utf8'),
    readFile(geogebraWorkbenchPath, 'utf8'),
    readFile(geogebraStudioPath, 'utf8'),
  ]);

  assert.match(canvasSource, /\/vendor\/geogebra\/deployggb\.js/);
  assert.match(canvasSource, /GEOGEBRA_RUNTIME_VERSION/);
  assert.match(canvasSource, /data-geogebra-runtime/);
  assert.match(canvasSource, /setHTML5Codebase\('\/vendor\/geogebra\/HTML5\/5\.0\/web3d\/'\)/);
  assert.match(canvasSource, /waitForGgbAppletConstructor/);
  assert.match(canvasSource, /window\.ggbAppletReady = true/);
  assert.match(canvasSource, /asyncEvalCommandGetLabels|evalCommand/);
  assert.match(canvasSource, /getXML/);

  assert.match(geogebraWorkbenchSource, /\/api\/geogebra\/plan/);
  assert.match(geogebraWorkbenchSource, /\/api\/geogebra\/repair/);
  assert.match(geogebraWorkbenchSource, /geogebraStudio/);
  assert.match(geogebraStudioSource, /geogebra-command-history/);
  assert.match(geogebraStudioSource, /executePlanCommands/);
});

test('Animation entry opens Manim and GeoGebra as explicit parallel choices', async () => {
  const [animationEntrySource, appSource, constantsSource, messageHandlerSource, modeSwitcherSource, workbenchSource, htmlSource, mainStyles, mobileStyles] = await Promise.all([
    readFile(animationEntryPath, 'utf8'),
    readFile(appPath, 'utf8'),
    readFile(constantsPath, 'utf8'),
    readFile(messageHandlerPath, 'utf8'),
    readFile(modeSwitcherPath, 'utf8'),
    readFile(workbenchPath, 'utf8'),
    readFile(indexPath, 'utf8'),
    readFile(mainStylesPath, 'utf8'),
    readFile(mobileStylesPath, 'utf8'),
  ]);

  assert.match(workbenchSource, /icecream_animation_engine_v1/);
  assert.match(workbenchSource, /geogebraWorkbench/);
  assert.doesNotMatch(workbenchSource, /renderAnimationEngineSwitch/);
  assert.doesNotMatch(workbenchSource, /data-animation-engine/);

  assert.match(animationEntrySource, /animation-entry-launcher/);
  assert.match(animationEntrySource, /Manim 视频动画/);
  assert.match(animationEntrySource, /GeoGebra 动态几何/);
  assert.match(animationEntrySource, /setAnimationEngine\?\.\('manim'\)/);
  assert.match(animationEntrySource, /setAnimationEngine\?\.\('geogebra'\)/);

  assert.match(modeSwitcherSource, /onAnimationEntryOpen/);
  assert.match(modeSwitcherSource, /mode === 'manim'/);

  assert.match(messageHandlerSource, /runGeoGebraPlan/);
  assert.match(messageHandlerSource, /looksLikeGeoGebraRequest/);
  assert.match(messageHandlerSource, /getAnimationEngine/);
  assert.match(messageHandlerSource, /refreshVisiblePanel/);

  assert.match(appSource, /animationEntryLauncher/);
  assert.match(constantsSource, /GeoGebra/);
  assert.match(htmlSource, /自然语言描述，生成 Manim 动画或 GeoGebra 动态几何/);
  assert.match(htmlSource, /title="选择动画类型"/);
  assert.match(mainStyles, /\.animation-entry-launcher/);
  assert.match(mainStyles, /\.animation-entry-card/);
  assert.match(mainStyles, /\.geogebra-canvas-root/);
  assert.match(mobileStyles, /\.animation-entry-panel/);
  assert.match(mobileStyles, /\.geogebra-canvas-root/);
});

test('GeoGebra vendor runtime includes the working offline web3d package', async () => {
  const [deploySource, web3dFiles] = await Promise.all([
    readFile(deployPath, 'utf8'),
    readdir(web3dPath),
  ]);
  const cacheFiles = web3dFiles.filter(file => file.endsWith('.cache.js'));
  const nocacheFile = new URL('web3d.nocache.js', web3dPath);

  assert.match(deploySource, /var applet_api\s*=\s*null/);
  assert.match(deploySource, /getAppletObject\s*=\s*function\(\)\s*{\s*return applet_api/);
  assert.ok(cacheFiles.length >= 1, 'GeoGebra web3d cache bundle is missing');
  assert.ok((await stat(nocacheFile)).isFile(), 'GeoGebra web3d nocache bootstrap is missing');
});
