import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const studioPath = new URL('../public/js/core/geogebra-studio.js', import.meta.url);
const workbenchPath = new URL('../public/js/core/geogebra-workbench.js', import.meta.url);
const studioShellPath = new URL('../public/js/core/geogebra-studio-shell.js', import.meta.url);
const canvasPath = new URL('../public/js/core/geogebra-canvas.js', import.meta.url);
const studioViewPath = new URL('../public/js/core/geogebra-studio-view.js', import.meta.url);
const timelinePlayerPath = new URL('../public/js/core/geogebra-timeline-player.js', import.meta.url);
const advancedDrawerPath = new URL('../public/js/core/geogebra-advanced-drawer.js', import.meta.url);
const automatedCheckPath = new URL('../public/js/core/geogebra-automated-check.js', import.meta.url);
const mainStylesPath = new URL('../public/css/main.css', import.meta.url);
const mobileStylesPath = new URL('../public/css/mobile.css', import.meta.url);

test('GeoGebra Studio exposes a maintainable adjustment workbench', async () => {
  const [studioSource, workbenchSource, studioShellSource, studioViewSource, timelinePlayerSource, advancedDrawerSource, automatedCheckSource, mainStyles, mobileStyles] = await Promise.all([
    readFile(studioPath, 'utf8'),
    readFile(workbenchPath, 'utf8'),
    readFile(studioShellPath, 'utf8'),
    readFile(studioViewPath, 'utf8'),
    readFile(timelinePlayerPath, 'utf8'),
    readFile(advancedDrawerPath, 'utf8'),
    readFile(automatedCheckPath, 'utf8'),
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
  assert.match(studioSource, /icecream_geogebra_studio_v2/);
  assert.match(studioSource, /\/api\/geogebra\/studio\/adjust/);
  assert.match(studioSource, /\/api\/geogebra\/studio\/parse-image/);
  assert.match(studioSource, /renderDrawingAssistant/);
  assert.match(studioSource, /renderAdvancedTools/);
  assert.match(studioSource, /geogebra-studio-view/);
  assert.match(studioSource, /geogebra-timeline-player/);
  assert.match(studioSource, /geogebra-advanced-drawer/);
  assert.match(studioSource, /geogebra-automated-check/);
  assert.match(studioSource, /runGeoGebraAutomatedCheck/);
  assert.match(studioSource, /latestAutomatedCheck/);
  assert.match(studioSource, /renderAutomatedCheckCard/);
  assert.match(studioViewSource, /data-geogebra-studio-action="draw-from-prompt"/);
  assert.match(studioViewSource, /data-geogebra-studio-action="redraw-from-prompt"/);
  assert.match(studioViewSource, /data-geogebra-studio-action="adjust-current-graph"/);
  assert.match(studioSource, /data-geogebra-studio-action="play-demo"/);
  assert.match(studioSource, /data-geogebra-studio-action="pause-demo"/);
  assert.match(studioSource, /data-geogebra-studio-action="replay-demo"/);
  assert.match(studioSource, /clearTrajectoryTrace/);
  assert.match(studioSource, /data-geogebra-studio-action="toggle-advanced-tools"/);
  assert.match(studioViewSource, /renderPresentationAssistant/);
  assert.match(studioViewSource, /绘图助手/);
  assert.match(studioViewSource, /播放演示/);
  assert.match(timelinePlayerSource, /normalizeTimelineDemo/);
  assert.match(timelinePlayerSource, /initialState/);
  assert.match(timelinePlayerSource, /stages/);
  assert.match(timelinePlayerSource, /construction/);
  assert.match(timelinePlayerSource, /path-trace/);
  assert.match(timelinePlayerSource, /move-point/);
  assert.match(studioSource, /runMovePointTrack/);
  assert.match(advancedDrawerSource, /renderAdvancedDrawer/);
  assert.match(advancedDrawerSource, /geogebra-advanced-drawer/);
  assert.match(automatedCheckSource, /collectPlanObjectReferences/);
  assert.match(automatedCheckSource, /runGeoGebraAutomatedCheck/);
  assert.match(automatedCheckSource, /move-point/);
  assert.match(automatedCheckSource, /angle/);
  assert.ok(studioSource.includes('\u64ad\u653e\u6f14\u793a'));
  assert.ok(studioSource.includes('\u6682\u505c\u6f14\u793a'));
  assert.match(studioSource, /clearTrajectoryTrace/);
  assert.match(studioViewSource, /data-geogebra-prompt-input/);
  assert.match(advancedDrawerSource, /data-geogebra-advanced-tools/);
  assert.ok(studioViewSource.includes('\u7ed8\u56fe\u52a9\u624b'));
  assert.ok(studioViewSource.includes('\u751f\u6210\u56fe\u5f62'));
  assert.ok(studioViewSource.includes('\u8c03\u6574\u5f53\u524d\u56fe'));
  assert.match(studioSource, /高级工具/);
  assert.doesNotMatch(studioSource, /renderStudioMessages/);
  assert.doesNotMatch(studioSource, /renderProblemReview/);
  assert.match(studioSource, /renderTab\('objects'/);
  assert.match(studioSource, /renderTab\('adjust'/);
  assert.match(studioSource, /renderTab\('commands'/);
  assert.match(studioSource, /renderTab\('manual'/);
  assert.match(studioSource, /renderTab\('projects'/);
  assert.match(studioSource, /renderTab\('history'/);
  assert.match(studioSource, /data-geogebra-studio-action="undo"/);
  assert.match(studioSource, /data-geogebra-studio-action="redo"/);
  assert.match(studioSource, /data-geogebra-studio-action="export"/);
  assert.match(studioSource, /data-geogebra-studio-action="export-courseware"/);
  assert.match(studioViewSource, /data-geogebra-studio-action="upload-problem"/);
  assert.match(studioSource, /data-geogebra-studio-action="retry-problem-image"/);
  assert.match(studioSource, /parseProblemImage/);
  assert.ok(studioSource.includes('\u6309\u4fee\u6b63\u6587\u9898\u91cd\u65b0\u7ed8\u56fe'));
  assert.match(studioSource, /async replanProblemText\(options = \{\}\)/);
  assert.match(studioSource, /const outcome = await this\.executePlanCommands\(payload\.data \|\| \{\}, \{[\s\S]*source: 'problem_replan'/);
  assert.match(studioSource, /resetBeforeExecute/);
  assert.match(studioSource, /requireVisibleObjects/);
  assert.match(studioSource, /canvasAfterExecution/);
  assert.ok(studioSource.includes('\u547d\u4ee4\u5df2\u8fd4\u56de\u4f46\u672a\u843d\u56fe'));
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
  assert.match(studioSource, /runTrajectoryDemo/);
  assert.match(studioSource, /exportCourseware/);
  assert.match(studioSource, /\/api\/geogebra\/export\/courseware/);
  assert.match(studioSource, /icecream-geogebra-courseware/);
  assert.match(studioSource, /problemText:\s*this\.problemReviewText/);
  assert.match(studioSource, /summary:\s*this\.latestSummary/);
  assert.match(studioSource, /demo:\s*this\.demoConfig/);
  assert.match(studioSource, /viewport:\s*this\.latestViewport/);
  assert.ok(studioSource.includes('导出互动课件包'));
  assert.match(studioSource, /stopTrajectoryDemo/);
  assert.match(studioSource, /clearTrajectoryTrace/);
  assert.match(studioSource, /normalizeTimelineDemo/);
  assert.match(studioSource, /runTimelineDemo/);
  assert.match(studioSource, /runTimelineTrack/);
  assert.match(studioSource, /runPathTraceTrack/);
  assert.match(studioSource, /requestAnimationFrame/);
  assert.match(timelinePlayerSource, /SetValue\(\$\{movingObject\}, \(\$\{formatGeoGebraNumber\(x\)\}, \$\{formatGeoGebraNumber\(y\)\}\)\)/);
  assert.match(timelinePlayerSource, /normalizeTimelineNumber\(track\.samples,\s*240,\s*24,\s*600\)/);
  assert.match(studioSource, /clearBeforePlay/);
  assert.match(studioSource, /preserveAfterFinish/);
  assert.match(studioSource, /StartAnimation\(\$\{movingObject\}, false\)/);
  assert.doesNotMatch(studioSource, /planBody\.demo\?\.autoPlay\s*&&[\s\S]*runTrajectoryDemo/);
  assert.match(studioSource, /applyDemoInitialState/);
  assert.match(studioSource, /runTimelineDemo/);
  assert.match(studioSource, /runTimelineStage/);
  assert.match(studioSource, /replayTrajectoryDemo/);
  const drawingAssistantStart = studioSource.indexOf('\n    renderDrawingAssistant() {');
  assert.notEqual(drawingAssistantStart, -1);
  const drawingAssistantBody = studioSource.slice(
    drawingAssistantStart,
    studioSource.indexOf('renderAssistantStatus()'),
  );
  assert.doesNotMatch(drawingAssistantBody, /renderAdvancedTools/);

  assert.match(mainStyles, /\.geogebra-studio-layout/);
  assert.match(mainStyles, /\.geogebra-studio-shell/);
  assert.match(mainStyles, /\.geogebra-drawing-assistant/);
  assert.match(mainStyles, /\.geogebra-assistant-scroll/);
  assert.match(mainStyles, /\.geogebra-advanced-drawer/);
  assert.match(mainStyles, /\.geogebra-playback-controls/);
  assert.match(mainStyles, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(mainStyles, /\.geogebra-demo-controls/);
  assert.match(mainStyles, /\.geogebra-result-panel/);
  assert.match(mainStyles, /\.geogebra-result-card/);
  assert.match(mainStyles, /\.geogebra-automated-check/);
  assert.match(mainStyles, /\.geogebra-check-list/);
  assert.doesNotMatch(mainStyles, /\.geogebra-result-card\s*\{[\s\S]*?max-height:\s*180px/);
  assert.match(mainStyles, /\.geogebra-recognized-problem/);
  assert.match(mainStyles, /\.geogebra-problem-upload/);
  assert.match(mainStyles, /\.geogebra-studio-sidebar/);
  assert.match(mainStyles, /\.geogebra-studio-object-list/);
  assert.match(mainStyles, /\.geogebra-studio-command-editor/);
  assert.match(mainStyles, /overflow-wrap:\s*anywhere/);
  assert.match(mobileStyles, /\.geogebra-studio-layout/);
  assert.match(mobileStyles, /\.geogebra-studio-shell/);
  assert.match(mobileStyles, /\.geogebra-drawing-assistant/);
  assert.match(mobileStyles, /\.geogebra-result-panel/);
  assert.match(mobileStyles, /\.geogebra-advanced-drawer/);
});

test('GeoGebra Studio stops trajectory demos on reset and shell close', async () => {
  const [studioSource, studioShellSource, workbenchSource] = await Promise.all([
    readFile(studioPath, 'utf8'),
    readFile(studioShellPath, 'utf8'),
    readFile(workbenchPath, 'utf8'),
  ]);

  assert.match(studioSource, /resetCanvas\(\)[\s\S]*await this\.stopTrajectoryDemo/);
  assert.match(studioSource, /executePlanCommands\(planBody = \{\}, options = \{\}\)[\s\S]*await this\.stopTrajectoryDemo/);
  assert.match(workbenchSource, /stopTrajectoryDemo\(\)/);
  assert.match(studioShellSource, /close\(\)[\s\S]*geogebraWorkbench\.stopTrajectoryDemo\(\)/);
});

test('GeoGebra canvas supports Studio snapshots without replacing existing APIs', async () => {
  const canvasSource = await readFile(canvasPath, 'utf8');

  assert.match(canvasSource, /captureSnapshot/);
  assert.match(canvasSource, /restoreSnapshot/);
  assert.match(canvasSource, /fitBoundsEqualScale/);
  assert.match(canvasSource, /setCoordSystem/);
  assert.match(canvasSource, /SetAxesRatio\(1,\s*1\)/);
  assert.match(canvasSource, /lastEqualScaleViewport/);
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
  assert.match(canvasSource, /this\.fitBoundsEqualScale\(this\.lastEqualScaleViewport/);
});

test('GeoGebra Studio applies equal-scale viewport after generated plans', async () => {
  const studioSource = await readFile(studioPath, 'utf8');

  assert.match(studioSource, /applyPlanViewport/);
  assert.match(studioSource, /planBody\.viewport/);
  assert.match(studioSource, /geogebraCanvas\.fitBoundsEqualScale/);
  assert.match(studioSource, /inferEqualScaleViewport/);
});
