import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import seatingPlanner from '../public/js/tools/seating-planner.js';

const sourcePath = new URL('../public/js/tools/seating-planner.js', import.meta.url);
const apiClientPath = new URL('../public/js/tools/seating-planner/api-client.js', import.meta.url);
const assistantPanelPath = new URL('../public/js/tools/seating-planner/assistant-panel.js', import.meta.url);
const exportPanelPath = new URL('../public/js/tools/seating-planner/export-panel.js', import.meta.url);
const feedbackPanelPath = new URL('../public/js/tools/seating-planner/feedback-panel.js', import.meta.url);
const gridPanelPath = new URL('../public/js/tools/seating-planner/grid-panel.js', import.meta.url);
const arrangementDiagramPanelPath = new URL('../public/js/tools/seating-planner/arrangement-diagram-panel.js', import.meta.url);
const layoutPreviewPanelPath = new URL('../public/js/tools/seating-planner/layout-preview-panel.js', import.meta.url);
const rosterPanelPath = new URL('../public/js/tools/seating-planner/roster-panel.js', import.meta.url);
const seatDetailPanelPath = new URL('../public/js/tools/seating-planner/seat-detail-panel.js', import.meta.url);
const stylePath = new URL('../public/css/seating-planner.css', import.meta.url);
const launcherPath = new URL('../public/js/tools/app-launcher.js', import.meta.url);

function createMockClassList(initial = []) {
  const classes = new Set(initial);
  return {
    add: (...names) => names.forEach(name => classes.add(name)),
    remove: (...names) => names.forEach(name => classes.delete(name)),
    contains: name => classes.has(name),
    toggle: (name, force) => {
      if (force === undefined) {
        if (classes.has(name)) classes.delete(name);
        else classes.add(name);
        return classes.has(name);
      }
      if (force) classes.add(name);
      else classes.delete(name);
      return Boolean(force);
    },
  };
}

function createMockElement({ hidden = true, display = '' } = {}) {
  return {
    classList: createMockClassList(hidden ? ['sp-hidden'] : []),
    style: { display },
  };
}

function createEscapeEvent() {
  return {
    key: 'Escape',
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
}

test('seating planner exposes natural-language requirements and an editable SVG recognition result', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const apiSource = await readFile(apiClientPath, 'utf8');
  const diagramSource = await readFile(arrangementDiagramPanelPath, 'utf8');
  const layoutPreviewSource = await readFile(layoutPreviewPanelPath, 'utf8');

  assert.match(source, /sp-arrange-prompt/);
  assert.match(source, /seatingApi\.fetchArrangement/);
  assert.match(source, /seatingApi\.fetchLayoutPreview/);
  assert.match(apiSource, /\/api\/tools\/seating\/arrange/);
  assert.match(apiSource, /\/api\/tools\/seating\/layout-preview/);
  assert.match(apiSource, /\/api\/tools\/seating\/layout-spec/);
  assert.match(source, /排座要求/);
  assert.match(source, /id="sp-parse-arrangement"/);
  assert.match(source, /id="sp-arrangement-diagram"/);
  assert.match(source, /id="sp-arrangement-rule-facts"/);
  assert.match(source, /id="sp-arrangement-open-editor"/);
  assert.match(source, /id="sp-arrangement-editor"/);
  assert.match(source, /id="sp-arrangement-editor-diagram"/);
  assert.match(source, /data-arrangement-mode="walkway"/);
  assert.match(source, /id="sp-arrangement-editor-cancel"/);
  assert.match(source, /id="sp-arrangement-restore-ai"/);
  assert.match(source, /id="sp-arrangement-apply"/);
  assert.match(source, /data-target="groupSize"/);
  assert.match(source, /id="sp-layout-requirement-summary"/);
  assert.match(source, /用自然语言描述排座方式/);
  assert.match(source, /getLayoutRequirementSpec\(\)/);
  assert.match(source, /seatingApi\.fetchLayoutSpec/);
  assert.match(source, /arrangementPromptSnapshot/);
  assert.match(source, /arrangementRecognitionStale/);
  assert.match(diagramSource, /要求已修改，请重新识别/);
  assert.match(diagramSource, /recognition\.source === 'ai_rule_parser'/);
  assert.match(diagramSource, /AI 排座规则识别完成/);
  assert.match(diagramSource, /AI 规则未采用，当前使用本地规则解析/);
  assert.match(source, />\s*生成布局预览\s*</);
  assert.match(layoutPreviewSource, /生成布局预览/);
  assert.match(diagramSource, /rows = compact \? 1 : 2/);
  assert.match(diagramSource, /groupsPerRow = 3/);
  assert.match(diagramSource, /Bootstrap Icons person-walking, MIT licensed/);
  assert.match(diagramSource, /sp-arrangement-svg__walkway-surface/);
  assert.match(diagramSource, /sp-arrangement-svg__walkway-edge/);
  assert.match(diagramSource, /sp-arrangement-svg__walkway-icon/);
  assert.match(diagramSource, /sp-arrangement-svg__chair/);
  assert.match(diagramSource, /boundaryWidths = Array\.from/);
  assert.match(diagramSource, /rowBoundaryMode = mainHorizontal \? 'walkway'/);
  assert.doesNotMatch(diagramSource, /walkway-arrow|walkway-label|gap-mark|label\.textContent = '过道'/);
  assert.doesNotMatch(source, /id="sp-arrangement-remap"/);
  assert.doesNotMatch(source, /id="sp-arrangement-reset"/);
  assert.doesNotMatch(diagramSource, /classroomLayout/);
  assert.doesNotMatch(diagramSource, /patternUnits|sp-walkway-pattern/);
  assert.doesNotMatch(source, /AI 排座需求/);
  assert.doesNotMatch(source, />\s*AI 生成座位表\s*</);
  assert.doesNotMatch(source, /data-layout-template=/);
  assert.doesNotMatch(source, /sp-layout-prompt/);
});

test('seating planner previews AI layout before confirming student assignment', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const layoutPreviewSource = await readFile(layoutPreviewPanelPath, 'utf8');

  assert.match(source, /pendingLayoutPreview/);
  assert.match(source, /requestLayoutPreview/);
  assert.match(layoutPreviewSource, /showLayoutPreviewConfirmation/);
  assert.match(layoutPreviewSource, /confirmLayoutPreview/);
  assert.match(layoutPreviewSource, /cancelLayoutPreview/);
  assert.match(layoutPreviewSource, /const confirmedLayout = this\.getConfirmedPreviewLayout\(\)/);
  assert.match(layoutPreviewSource, /confirmedLayout,/);
  assert.match(source, /sp-layout-preview-confirm/);
  assert.match(source, /sp-layout-preview-cancel/);
  assert.match(source, /sp-layout-preview-edit/);
  assert.match(layoutPreviewSource, /returnToArrangementEditor/);
  assert.match(layoutPreviewSource, /this\.openArrangementEditor\?\.\(\)/);
  assert.match(layoutPreviewSource, /arrangementSpec: this\.recognizedArrangement\.arrangementSpec/);
  assert.doesNotMatch(source, /sp-layout-preview-regenerate/);
  assert.doesNotMatch(source, /const data = await this\.requestAiArrangement\(prompt\);\s*const arrangement = this\.applyArrangementResult\(data\);/s);
});

test('seating planner renders the editable layout preview on the primary canvas', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const layoutPreviewSource = await readFile(layoutPreviewPanelPath, 'utf8');
  const gridSource = await readFile(gridPanelPath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /id="sp-layout-preview-summary"/);
  assert.match(source, /id="sp-layout-preview-meta"/);
  assert.match(layoutPreviewSource, /capturePrimaryCanvasState/);
  assert.match(layoutPreviewSource, /applyLayoutPreviewToPrimaryCanvas/);
  assert.match(layoutPreviewSource, /restorePrimaryCanvasState/);
  assert.match(layoutPreviewSource, /renderPrimaryLayoutPreviewSummary/);
  assert.match(layoutPreviewSource, /this\.layout = this\.previewAssignmentGrid\(normalized\)/);
  assert.match(layoutPreviewSource, /localAisles: normalizeLocalAisles\(source\.localAisles, rows, cols\)/);
  assert.match(gridSource, /pendingLayoutPreview\.classroomLayout = structuredClone\(this\.classroomLayout\)/);
  assert.match(styles, /\.sp-classroom-view--preview/);
  assert.match(styles, /\.sp-canvas-preview-bar/);
  assert.match(styles, /\.sp-seat--unavailable/);
  assert.doesNotMatch(source, /sp-layout-preview-mini/);
  assert.doesNotMatch(layoutPreviewSource, /renderEditableLayoutPreviewGrid/);
  assert.doesNotMatch(styles, /\.sp-layout-preview-mini/);
});

test('seating planner shows group identity and local gaps on the primary canvas', async () => {
  const gridSource = await readFile(gridPanelPath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(gridSource, /decorateSeatGroup/);
  assert.match(gridSource, /cell\.dataset\.group = String\(groupId\)/);
  assert.match(gridSource, /sp-seat--group-even/);
  assert.match(gridSource, /sp-seat--group-odd/);
  assert.match(gridSource, /sp-seat--group-start/);
  assert.match(gridSource, /sp-seat--group-end/);
  assert.match(gridSource, /gridColumnTrackTemplate/);
  assert.match(gridSource, /aisleOnly \? '28px'/);
  assert.doesNotMatch(gridSource, /sp-seat--group-link-right/);
  assert.doesNotMatch(styles, /\.sp-seat--group-link-right::before/);
  assert.match(styles, /\.sp-classroom-view--preview \.sp-seat--grouped::before/);
  assert.match(styles, /\.sp-classroom-view--preview \.sp-seat--group-start::before/);
  assert.match(styles, /\.sp-classroom-view--preview \.sp-local-aisle-marker--vertical/);
});

test('seating planner keeps preview facts and confirmation controls together above the canvas', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const layoutPreviewSource = await readFile(layoutPreviewPanelPath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /class="sp-canvas-preview-bar sp-hidden"/);
  assert.match(source, />布局预览</);
  assert.match(source, /id="sp-layout-preview-summary"/);
  assert.match(source, /id="sp-layout-preview-meta"/);
  assert.match(source, /确认并排学生/);
  assert.match(layoutPreviewSource, /primaryLayoutPreviewFacts/);
  assert.match(layoutPreviewSource, /emptySeats/);
  assert.match(layoutPreviewSource, /中央竖主过道/);
  assert.match(layoutPreviewSource, /中央横主过道/);
  assert.match(styles, /\.sp-canvas-preview-bar\s*{[^}]*position:\s*sticky/s);
  assert.match(styles, /\.sp-canvas-preview-copy strong\s*{[^}]*text-overflow:\s*ellipsis/s);
  assert.doesNotMatch(source, /sp-layout-preview-title/);
  assert.doesNotMatch(styles, /\.sp-layout-preview-stage/);
});

test('seating planner restores cancelled previews and assigns only after confirmation', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const layoutPreviewSource = await readFile(layoutPreviewPanelPath, 'utf8');

  assert.match(source, /applyArrangementResult\(data,\s*\{[^}]*preserveLayoutPreview = false/s);
  assert.match(source, /if \(!preserveLayoutPreview\) this\.cancelLayoutPreview\(\)/);
  assert.match(layoutPreviewSource, /const previousState = this\.pendingLayoutPreview\?\.previousState/);
  assert.match(layoutPreviewSource, /this\.restorePrimaryCanvasState\(previousState\)/);
  assert.match(layoutPreviewSource, /const confirmedLayout = this\.getConfirmedPreviewLayout\(\)/);
  assert.match(layoutPreviewSource, /arrangementSpec: this\.pendingLayoutPreview\.arrangementSpec/);
  assert.match(layoutPreviewSource, /preserveLayoutPreview:\s*true/);
  assert.match(layoutPreviewSource, /this\.finishLayoutPreview\(\)/);
  assert.doesNotMatch(layoutPreviewSource, /showConfirmedLayoutPreview/);
  assert.doesNotMatch(layoutPreviewSource, /readOnly:\s*(?:true|false)/);
  assert.doesNotMatch(layoutPreviewSource, /confirmed:\s*(?:true|false)/);
});

test('seating planner displays confirmed local aisles as seat gaps', async () => {
  const gridSource = await readFile(gridPanelPath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(gridSource, /appendLocalAisleMarkers/);
  assert.match(gridSource, /sp-local-aisle-marker--vertical/);
  assert.match(gridSource, /sp-local-aisle-marker--horizontal/);
  assert.match(gridSource, /hasLocalAisle\(localAisles, 'vertical', row, col\)/);
  assert.match(gridSource, /hasLocalAisle\(localAisles, 'horizontal', row, col\)/);
  assert.match(styles, /\.sp-local-aisle-marker/);
  assert.match(styles, /\.sp-local-aisle-marker--vertical/);
  assert.match(styles, /\.sp-local-aisle-marker--horizontal/);
});

test('seating planner has a large-grid virtual rendering guard', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const gridSource = await readFile(gridPanelPath, 'utf8');

  assert.match(source, /VIRTUAL_GRID_CELL_THRESHOLD/);
  assert.match(gridSource, /renderVirtualGrid/);
  assert.match(gridSource, /sp-grid--virtual/);
});

test('seating planner auto-fits wide grids horizontally without clipping seats', async () => {
  const gridSource = await readFile(gridPanelPath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');
  const gridRule = styles.match(/\.sp-grid\s*{[^}]*}/s)?.[0] || '';

  assert.match(gridSource, /fitGridToClassroomView\(\)\s*{/);
  assert.match(gridSource, /this\.fitGridToClassroomView\(\);\s*this\.syncPodiumSeatWidth\(\);\s*this\.renderAisleGapHandles\(\);/s);
  assert.match(gridSource, /this\._resizeHandler = \(\) => \{\s*this\.fitGridToClassroomView\(\);/s);
  assert.match(gridRule, /--sp-grid-fit-scale:\s*1/);
  assert.match(gridRule, /transform:\s*scale\(var\(--sp-grid-fit-scale,\s*1\)\)/);
  assert.match(gridRule, /transform-origin:\s*top left/);
});

test('seating planner positions aisle handles from scaled visible seat bounds', async () => {
  const gridSource = await readFile(gridPanelPath, 'utf8');

  assert.match(gridSource, /getVisibleGridSeatBounds\(\)/);
  assert.match(gridSource, /const visualGridBounds = this\.getVisibleGridSeatBounds\(\)/);
  assert.match(gridSource, /handle\.style\.left = `\$\{toLayerLeft\(visualGridBounds\.left\)\}px`/);
  assert.match(gridSource, /handle\.style\.width = `\$\{visualGridBounds\.width\}px`/);
  assert.doesNotMatch(gridSource, /handle\.style\.width = `\$\{gridRect\.width\}px`/);
});

test('seating planner shows clearer strategy labels and applied strategy status', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /搭配偏好/);
  assert.match(source, /身高照顾/);
  assert.match(source, /优秀优先/);
  assert.match(source, /appliedStrategies/);
});

test('seating planner surfaces the Timefold arrangement source in status', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /arrangementSource/);
  assert.match(source, /source: data\.source \|\| null/);
  assert.match(source, /Timefold 优化/);
  assert.match(source, /arrangementInterpretation/);
  assert.match(source, /explainButton\.id = 'sp-toggle-arrangement-explain'/);
  assert.match(source, /renderArrangementExplainPanel/);
  assert.match(source, /Timefold 负责学生分配，不改变布局列数/);
  assert.match(source, /sp-status-item--solver/);
  assert.match(styles, /\.sp-arrangement-explain/);
  assert.match(styles, /\.sp-status-item--solver/);
});

test('seating planner exposes a feedback entry before the tool theme toggle', async () => {
  const launcherSource = await readFile(launcherPath, 'utf8');
  const plannerSource = await readFile(sourcePath, 'utf8');
  const apiSource = await readFile(apiClientPath, 'utf8');
  const feedbackSource = await readFile(feedbackPanelPath, 'utf8');
  const plannerStyles = await readFile(stylePath, 'utf8');

  const feedbackIndex = launcherSource.indexOf('tool-feedback-btn');
  const themeIndex = launcherSource.indexOf('tool-theme-toggle');
  assert.ok(feedbackIndex > -1, 'feedback button should exist in the tool header');
  assert.ok(themeIndex > -1, 'theme toggle should exist in the tool header');
  assert.ok(feedbackIndex < themeIndex, 'feedback button should be rendered before the theme toggle');
  assert.match(launcherSource, /tool\.id === 'seating'/);
  assert.match(launcherSource, /openFeedbackDialog/);
  assert.match(launcherSource, /const moduleVersion = encodeURIComponent\(window\.ICeCream\?\.assetVersion \|\| Date\.now\(\)\)/);
  assert.match(launcherSource, /`\.\/\$\{tool\.module\}\.js\?v=\$\{moduleVersion\}`/);

  assert.match(plannerSource, /seatingFeedbackMethods/);
  assert.match(plannerSource, /seatingRosterMethods/);
  assert.match(plannerSource, /Object\.assign\(\s*SeatingPlanner\.prototype,[\s\S]*seatingArrangementDiagramMethods,[\s\S]*seatingSeatDetailMethods\s*\)/);
  assert.match(feedbackSource, /openFeedbackDialog/);
  assert.match(feedbackSource, /buildFeedbackSnapshot/);
  assert.match(feedbackSource, /recordDiagnosticEvent/);
  assert.match(feedbackSource, /loadBackendDiagnostics/);
  assert.match(feedbackSource, /seatingApi\.fetchFeedback/);
  assert.match(feedbackSource, /seatingApi\.fetchDiagnostics/);
  assert.match(apiSource, /\/api\/tools\/seating\/feedback/);
  assert.match(apiSource, /\/api\/tools\/seating\/diagnostics/);
  assert.match(plannerSource, /sp-feedback-screenshot/);
  assert.match(plannerSource, /sp-feedback-screenshot-preview/);
  assert.match(plannerSource, /sp-feedback-screenshot-status/);
  assert.match(plannerSource, /sp-feedback-screenshot-recapture/);
  assert.match(plannerSource, /sp-feedback-screenshot-redact/);
  assert.match(plannerSource, /sp-feedback-screenshot-fallback/);
  assert.match(feedbackSource, /captureFeedbackScreenshot/);
  assert.match(feedbackSource, /getFeedbackScreenshotTarget/);
  assert.match(feedbackSource, /captureFeedbackScreenScreenshot/);
  assert.match(feedbackSource, /drawScreenCaptureFrameToCanvas/);
  assert.match(feedbackSource, /getFeedbackScreenshotCropRect/);
  assert.match(feedbackSource, /applyFeedbackScreenshotRedactionMasks/);
  assert.match(feedbackSource, /prepareFeedbackScreenshotClone/);
  assert.match(feedbackSource, /navigator\.mediaDevices\.getDisplayMedia/);
  assert.match(feedbackSource, /this\.ensureHtml2Canvas\(\)/);
  assert.match(feedbackSource, /document\.querySelector\('\.sp-main'\)/);
  assert.match(feedbackSource, /onclone:\s*clonedDocument => this\.prepareFeedbackScreenshotClone\(clonedDocument,\s*privacyMode\)/);
  assert.match(feedbackSource, /sp-feedback-capture--redacted/);
  assert.match(plannerSource, /_feedbackScreenshotState/);
  assert.match(plannerSource, /_feedbackScreenshotQueuedPrivacyMode/);
  assert.match(plannerSource, /_feedbackScreenshotRunning/);
  assert.match(feedbackSource, /screenshot:\s*this\._feedbackScreenshot/);
  assert.match(feedbackSource, /await this\._feedbackScreenshotPromise/);
  assert.match(feedbackSource, /diagnostics_request_failed/);
  assert.match(plannerSource, /反馈座位安排问题/);
  assert.match(plannerSource, /直接写您觉得哪里不对/);
  assert.match(plannerSource, /您希望它怎么做/);
  assert.doesNotMatch(plannerSource, /直接写你觉得哪里不对/);
  assert.doesNotMatch(plannerSource, /你希望它怎么做/);
  assert.match(plannerSource, /会附带脱敏座位快照，帮助我们复现问题/);
  assert.match(plannerStyles, /\.sp-feedback/);
  assert.match(plannerStyles, /\.sp-feedback-chip/);
  assert.match(plannerStyles, /\.sp-feedback-screenshot/);
  assert.match(plannerStyles, /\.sp-feedback-screenshot-preview/);
  assert.match(plannerStyles, /\.sp-feedback-capture--redacted/);
});

test('seating feedback screenshots use real screen capture with stable fallback', async () => {
  const feedbackSource = await readFile(feedbackPanelPath, 'utf8');
  const plannerStyles = await readFile(stylePath, 'utf8');

  const openBody = feedbackSource.match(/openFeedbackDialog\(\)\s*{([\s\S]*?)\r?\n    },\r?\n\r?\n    closeFeedbackDialog/)?.[1] || '';
  assert.match(openBody, /captureFeedbackScreenshot/);
  assert.match(openBody, /dialog\.classList\.remove\('sp-hidden'\)/);

  const captureBody = feedbackSource.match(/captureFeedbackScreenshot\(\{[\s\S]*?mode = 'screen'[\s\S]*?\r?\n    },\r?\n\r?\n    async openFeedbackDialog/)?.[0] || '';
  assert.match(captureBody, /const previousScreenshot = this\._feedbackScreenshot/);
  assert.doesNotMatch(captureBody, /this\._feedbackScreenshot = null;\s*this\.setFeedbackScreenshotLoading/);
  assert.match(captureBody, /this\._feedbackScreenshot = previousScreenshot/);
  assert.match(captureBody, /重新截图失败，已保留上一张/);
  assert.match(captureBody, /this\._feedbackScreenshotRunning/);
  assert.match(captureBody, /this\._feedbackScreenshotQueuedPrivacyMode/);
  assert.match(captureBody, /captureFeedbackScreenScreenshot/);
  assert.match(captureBody, /captureFeedbackDomFallbackScreenshot/);

  assert.match(feedbackSource, /navigator\.mediaDevices\.getDisplayMedia/);
  assert.match(feedbackSource, /preferCurrentTab:\s*true/);
  assert.match(feedbackSource, /getFeedbackScreenshotCropRect\(target,\s*frame/);
  assert.match(feedbackSource, /drawScreenCaptureFrameToCanvas\(video,\s*cropRect\)/);
  assert.match(feedbackSource, /applyFeedbackScreenshotRedactionMasks\(canvas,\s*cropRect/);
  assert.match(feedbackSource, /stream\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
  assert.match(feedbackSource, /prepareFeedbackScreenshotClone\(clonedDocument,\s*privacyMode\)/);
  assert.match(feedbackSource, /clonedDocument\.querySelectorAll\('\.sp-feedback,\s*\.sp-chat,\s*\.sp-context-menu,\s*\.sp-seat-tooltip,\s*\.sp-autocomplete'\)/);
  assert.doesNotMatch(feedbackSource, /setFeedbackCaptureMode/);
  assert.doesNotMatch(plannerStyles, /\.sp-feedback--capture-hidden/);
  assert.doesNotMatch(plannerStyles, /\.sp-feedback-capture--active\s+\.sp-blackboard/);
  assert.doesNotMatch(plannerStyles, /\.sp-feedback-capture--active\s+\.sp-blackboard-scene/);
  assert.doesNotMatch(plannerStyles, /\.sp-feedback-capture--active\s+:is\(\.sp-blackboard-frame,\s*\.sp-chalk-tray\)/);
  assert.match(plannerStyles, /\.sp-feedback-screenshot-recapture/);
  assert.match(plannerStyles, /\.sp-feedback-screenshot-recapture:disabled/);
  assert.doesNotMatch(plannerStyles, /\.sp-feedback-screenshot-recapture\.is-loading\s+\.lucide/);
  assert.doesNotMatch(feedbackSource, /recapture\.classList\.toggle\('is-loading'/);
});

test('feedback screen capture crop rect scales viewport coordinates to video pixels', () => {
  const originalWindow = global.window;
  const originalDocument = global.document;
  global.window = {
    visualViewport: { width: 800, height: 600 },
    innerWidth: 800,
    innerHeight: 600,
  };
  global.document = { documentElement: { clientWidth: 800, clientHeight: 600 } };

  try {
    const target = {
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 400, height: 300 }),
    };
    const rect = seatingPlanner.getFeedbackScreenshotCropRect(target, { width: 1600, height: 1200 });
    assert.deepEqual(
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scaleX: rect.scaleX, scaleY: rect.scaleY },
      { x: 200, y: 100, width: 800, height: 600, scaleX: 2, scaleY: 2 }
    );
  } finally {
    global.window = originalWindow;
    global.document = originalDocument;
  }
});

test('feedback screenshot redaction masks only scaled sensitive rectangles', () => {
  const calls = [];
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    beginPath: () => calls.push(['beginPath']),
    roundRect: (...args) => calls.push(['roundRect', ...args]),
    fill: () => calls.push(['fill']),
    stroke: () => calls.push(['stroke']),
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
  };
  const canvas = { width: 500, height: 300, getContext: () => context };
  const cropRect = { x: 20, y: 10, width: 500, height: 300, scaleX: 2, scaleY: 2 };
  const elements = [
    { getBoundingClientRect: () => ({ left: 30, top: 20, width: 60, height: 15 }) },
    { getBoundingClientRect: () => ({ left: 250, top: 140, width: 20, height: 20 }) },
  ];

  seatingPlanner.applyFeedbackScreenshotRedactionMasks(canvas, cropRect, elements);

  assert.deepEqual(calls.filter(call => call[0] === 'roundRect')[0], ['roundRect', 40, 30, 120, 30, 6]);
  assert.deepEqual(calls.filter(call => call[0] === 'roundRect')[1], ['roundRect', 480, 270, 20, 30, 6]);
});

test('seating feedback snapshot anonymizes names and keeps useful seating context', () => {
  seatingPlanner.students = [
    { id: 's01', name: '张三', gender: 'M', grade: 88, height: 171 },
    { id: 's02', name: '李四', gender: 'F', grade: 73, height: 160 },
  ];
  seatingPlanner._buildStudentMap();
  seatingPlanner.rows = 1;
  seatingPlanner.cols = 2;
  seatingPlanner.layout = [['s01', 's02']];
  seatingPlanner.guardians = ['s01', null];
  seatingPlanner.constraints = [{ type: 'avoid', target: '张三', related: '李四', reason: '不要相邻' }];
  seatingPlanner.strategy = { genderBalance: true, gradeStrategy: 'balance', heightOrder: false };
  seatingPlanner.arrangementStats = { solverUsed: true, solverName: 'Timefold Solver' };
  seatingPlanner.arrangementSource = 'timefold_solver';
  seatingPlanner.arrangementSpec = { groupSize: 2, groupsPerRow: 5 };
  seatingPlanner.arrangementInterpretation = { summary: '已理解为两人一组' };
  seatingPlanner.unassigned = [];
  seatingPlanner._diagnosticEvents = [];
  seatingPlanner._lastErrors = [];
  seatingPlanner.recordDiagnosticEvent('chat_noop', {
    student: 's01',
    message: 'Bearer live-secret-token',
    token: 'live-secret-token',
  });

  const snapshot = seatingPlanner.buildFeedbackSnapshot();
  const text = seatingPlanner.anonymizeFeedbackText('张三和李四没有按要求排开', snapshot.anonymizer);
  const serialized = JSON.stringify({ snapshot, text });

  assert.match(serialized, /stu_001/);
  assert.match(serialized, /stu_002/);
  assert.match(serialized, /80-89/);
  assert.match(serialized, /70-79/);
  assert.match(serialized, /170-179/);
  assert.match(serialized, /"diagnosticsVersion":2/);
  assert.match(serialized, /chat_noop/);
  assert.match(serialized, /arrangementSpec/);
  assert.match(serialized, /timefold_solver/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotMatch(serialized, /张三|李四/);
  assert.doesNotMatch(serialized, /live-secret-token/);
  assert.equal(snapshot.layout[0][0], 'stu_001');
  assert.equal(snapshot.guardians.left, 'stu_001');
});

test('seating planner frames constraints as student seating needs in the UI', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const seatDetailSource = await readFile(seatDetailPanelPath, 'utf8');

  assert.match(source, /学生需求/);
  assert.match(source, /收集学生想坐哪里/);
  assert.match(source, /提取需求/);
  assert.match(source, /满足 \$\{evaluation\.satisfied\}\/\$\{evaluation\.total\} 需求/);
  assert.doesNotMatch(source, /AI 提取需求/);
  assert.doesNotMatch(source, /学生座位需求/);
  assert.doesNotMatch(source, /座位约束/);
  assert.doesNotMatch(source, /描述座位约束/);
  assert.match(source, /prefer_edge/);
  assert.match(seatDetailSource, /靠边/);
});

test('seating planner lets teachers adjust extracted needs before arranging', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /renderConstraintsList\(\)/);
  assert.match(source, /toggleConstraintPriority\(index\)/);
  assert.match(source, /deleteConstraint\(index\)/);
  assert.match(source, /constraintPriorityTitle/);
  assert.match(source, /data-constraint-priority/);
  assert.match(source, /data-delete-constraint/);
  assert.match(source, /this\.constraints\[index\]\.priority = current === 'hard' \? 'soft' : 'hard'/);
  assert.match(source, /this\.constraints\.splice\(index,\s*1\)/);
  assert.match(source, /this\.refreshConstraintStatus\(\);\s*this\.updateStatus\(\);/s);
  assert.match(styles, /\.sp-constraint-actions/);
  assert.match(styles, /\.sp-constraint-priority\s*{[^}]*cursor:\s*pointer/s);
  assert.match(styles, /\.sp-constraint-delete/);
});

test('seating planner can show and hide seat grade and height details', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const seatDetailSource = await readFile(seatDetailPanelPath, 'utf8');

  assert.match(source, /showSeatDetails/);
  assert.match(source, /sp-toggle-seat-details/);
  assert.match(seatDetailSource, /sp-seat-meta/);
  assert.match(seatDetailSource, /renderSeatMeta/);
});

test('seating planner disables the old hover personal-info tooltip', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const gridSource = await readFile(gridPanelPath, 'utf8');
  const seatDetailSource = await readFile(seatDetailPanelPath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.doesNotMatch(source, /tooltip\.className = 'sp-seat-tooltip'/);
  assert.doesNotMatch(source, /const tooltip = document\.createElement\('div'\);[\s\S]{0,240}sp-seat-tooltip/);
  assert.doesNotMatch(styles, /\.sp-seat--filled:hover\s+\.sp-seat-tooltip\s*{/);
  assert.match(gridSource, /bindSeatDetailPopover\(cell,\s*student\.id\)/);
  assert.match(seatDetailSource, /showSeatDetailPopover\(event,\s*studentId\)/);
});

test('seating planner stacks desk status icons in the lower right corner', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const deskItemsRule = styles.match(/\.sp-desk-items\s*{[^}]*}/s)?.[0] || '';
  const booksRule = styles.match(/\.sp-desk-item--books\s*{[^}]*}/s)?.[0] || '';

  assert.match(deskItemsRule, /bottom:\s*4px/);
  assert.match(deskItemsRule, /right:\s*4px/);
  assert.match(deskItemsRule, /flex-direction:\s*column/);
  assert.match(deskItemsRule, /align-items:\s*flex-end/);
  assert.doesNotMatch(deskItemsRule, /left:/);
  assert.doesNotMatch(deskItemsRule, /justify-content:\s*space-between/);
  assert.doesNotMatch(booksRule, /margin-left:\s*auto/);
});

test('seating planner renders desk icons through one helper for normal virtual and guardian seats', async () => {
  const gridSource = await readFile(gridPanelPath, 'utf8');
  const seatDetailSource = await readFile(seatDetailPanelPath, 'utf8');

  assert.match(gridSource, /renderDeskItems\(student\)/);
  assert.match(gridSource, /createVirtualSeatCell\(r,\s*c[^)]*\)[\s\S]*renderDeskItems\(student\)/);
  assert.match(gridSource, /renderGrid\(\)[\s\S]*renderDeskItems\(student\)/);
  assert.match(gridSource, /renderPodiumSeats\(\)[\s\S]*renderDeskItems\(student\)/);
  assert.match(seatDetailSource, /studentHasUnmetNeed\(student\.id\)/);
  assert.match(seatDetailSource, /studentHasSatisfiedNeed\(student\.id\)/);
  assert.match(seatDetailSource, /近视\|戴眼镜\|视力\|看不清\|看不见\|看不到\|黑板/);
  assert.doesNotMatch(seatDetailSource, /indicators\.some\(i => i\.reason\?\.includes\('视力'\)\)/);
});

test('seating planner opens a detailed popover when clicking assigned seats', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const gridSource = await readFile(gridPanelPath, 'utf8');
  const seatDetailSource = await readFile(seatDetailPanelPath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');
  const popoverRule = styles.match(/\.sp-seat-detail-popover\s*{[^}]*}/s)?.[0] || '';
  const lightPopoverRule = styles.match(/body\.light-mode\s+\.sp-seat-detail-popover\s*{[^}]*}/s)?.[0] || '';

  assert.match(seatDetailSource, /buildSeatDetail\(studentId\)\s*{/);
  assert.match(seatDetailSource, /showSeatDetailPopover\(event,\s*studentId\)\s*{/);
  assert.match(seatDetailSource, /hideSeatDetailPopover\(\)\s*{/);
  assert.match(seatDetailSource, /syncSeatDetailPopoverPosition\(\)\s*{/);
  assert.match(seatDetailSource, /findSeatDetailAnchor\(studentId\)\s*{/);
  assert.match(seatDetailSource, /scheduleSeatDetailPopoverSync\(\)\s*{/);
  assert.match(seatDetailSource, /bindSeatDetailPopover\(cell,\s*studentId\)\s*{/);
  assert.match(seatDetailSource, /unbindSeatDetailPopover\(cell\)\s*{/);
  assert.match(seatDetailSource, /this\._seatDetailAnchor = null/);
  assert.match(seatDetailSource, /this\._seatDetailStudentId = null/);
  assert.match(gridSource, /delete seat\.dataset\.studentId/);
  assert.match(gridSource, /createVirtualSeatCell\(r,\s*c[^)]*\)[\s\S]*bindSeatDetailPopover\(cell,\s*studentId\)/);
  assert.match(gridSource, /renderGrid\(\)[\s\S]*bindSeatDetailPopover\(cell,\s*student\.id\)/);
  assert.match(gridSource, /renderPodiumSeats\(\)[\s\S]*bindSeatDetailPopover\(seat,\s*student\.id\)/);
  assert.match(gridSource, /this\._justDragged = true/);
  assert.match(seatDetailSource, /if \(this\._justDragged\) return/);
  assert.match(seatDetailSource, /addEventListener\('pointerup', cell\._seatDetailPointerUpHandler\)/);
  assert.match(seatDetailSource, /this\._seatDetailSuppressClickUntil = Date\.now\(\) \+ 220/);
  assert.match(seatDetailSource, /dx > 5 \|\| dy > 5 \|\| this\._justDragged/);
  assert.match(seatDetailSource, /studentHasVisionNeed\(student\.id\)/);
  assert.match(seatDetailSource, /isTopGradeStudent\(student\)/);
  assert.match(seatDetailSource, /studentHasSatisfiedNeed\(student\.id\)/);
  assert.match(seatDetailSource, /studentHasUnmetNeed\(student\.id\)/);
  assert.match(seatDetailSource, /Escape[\s\S]*hideSeatDetailPopover/);
  assert.match(seatDetailSource, /document\.addEventListener\('keydown', this\._seatDetailKeyHandler\)/);
  assert.match(seatDetailSource, /document\.addEventListener\('click', this\._seatDetailOutsideClickHandler\)/);
  assert.match(seatDetailSource, /document\.removeEventListener\('click', this\._seatDetailOutsideClickHandler\)/);
  assert.match(seatDetailSource, /anchor\.classList\.add\('sp-seat--detail-open'\)/);
  assert.match(seatDetailSource, /classList\.remove\('sp-seat--detail-open'\)/);
  assert.match(seatDetailSource, /document\.querySelectorAll\('\.sp-seat--filled\[data-student-id\]'\)/);
  assert.match(seatDetailSource, /requestAnimationFrame\(\(\) => this\.syncSeatDetailPopoverPosition\(\)\)/);
  assert.match(seatDetailSource, /addEventListener\('scroll', this\._seatDetailScrollHandler/);
  assert.match(seatDetailSource, /removeEventListener\('scroll', this\._seatDetailScrollHandler/);
  assert.match(seatDetailSource, /window\.addEventListener\('resize', this\._seatDetailResizeHandler\)/);
  assert.match(seatDetailSource, /window\.removeEventListener\('resize', this\._seatDetailResizeHandler\)/);
  assert.match(seatDetailSource, /popover\.style\.left = `\$\{left\}px`/);
  assert.match(seatDetailSource, /popover\.style\.top = `\$\{Math\.max\(8,\s*top\)\}px`/);
  assert.doesNotMatch(seatDetailSource, /window\.scrollX/);
  assert.doesNotMatch(seatDetailSource, /window\.scrollY/);

  assert.match(styles, /\.sp-seat-detail-popover/);
  assert.match(popoverRule, /position:\s*fixed/);
  assert.match(popoverRule, /z-index:\s*10020/);
  assert.match(popoverRule, /--sp-seat-detail-bg:/);
  assert.match(popoverRule, /--sp-seat-detail-text:/);
  assert.match(popoverRule, /background:\s*var\(--sp-seat-detail-bg\)/);
  assert.match(popoverRule, /color:\s*var\(--sp-seat-detail-text\)/);
  assert.match(lightPopoverRule, /--sp-seat-detail-bg:\s*rgba\(255,\s*255,\s*255/);
  assert.match(lightPopoverRule, /--sp-seat-detail-text:\s*#0f172a/);
  assert.match(styles, /\.sp-seat-detail-header/);
  assert.match(styles, /\.sp-seat-detail-icons/);
  assert.match(styles, /\.sp-seat-detail-icon-row/);
  assert.match(styles, /\.sp-seat-detail-constraints/);
  assert.match(styles, /\.sp-seat-detail-popover--above/);
  assert.match(styles, /\.sp-seat-detail-popover--below/);
  assert.match(styles, /\.sp-seat--filled:hover,\s*\.sp-seat--detail-open\s*{[^}]*transform:\s*translateY\(-8px\)/s);
  assert.match(styles, /@keyframes spSeatDetailIn/);
});

test('seating planner handles Escape by stepping back through classroom tool layers', () => {
  const previousDocument = globalThis.document;
  const elements = new Map();
  const calls = [];
  const originals = {
    closeFeedbackDialog: seatingPlanner.closeFeedbackDialog,
    closeImageReview: seatingPlanner.closeImageReview,
    closeRosterBulkPanel: seatingPlanner.closeRosterBulkPanel,
    cancelLayoutPreview: seatingPlanner.cancelLayoutPreview,
    hideContextMenu: seatingPlanner.hideContextMenu,
    hideSeatDetailPopover: seatingPlanner.hideSeatDetailPopover,
    cancelChatPending: seatingPlanner.cancelChatPending,
    toggleChat: seatingPlanner.toggleChat,
    updateStatus: seatingPlanner.updateStatus,
  };

  globalThis.document = {
    getElementById: id => elements.get(id) || null,
    querySelector: selector => (selector === '.sp-seat-detail-popover'
      ? elements.get('seat-detail-popover') || null
      : null),
  };

  seatingPlanner.closeFeedbackDialog = () => {
    calls.push('feedback');
    elements.get('sp-feedback-dialog')?.classList.add('sp-hidden');
  };
  seatingPlanner.closeImageReview = () => {
    calls.push('image');
    elements.get('sp-image-review')?.classList.add('sp-hidden');
  };
  seatingPlanner.closeRosterBulkPanel = () => {
    calls.push('roster-bulk');
    elements.get('sp-roster-bulk-panel')?.classList.add('sp-hidden');
  };
  seatingPlanner.cancelLayoutPreview = () => {
    calls.push('layout-preview');
    seatingPlanner.pendingLayoutPreview = null;
    elements.get('sp-layout-preview-confirm')?.classList.add('sp-hidden');
  };
  seatingPlanner.hideContextMenu = () => {
    calls.push('context');
    elements.get('sp-context-menu')?.classList.remove('sp-context-menu--visible');
  };
  seatingPlanner.hideSeatDetailPopover = () => {
    calls.push('seat-detail');
    elements.delete('seat-detail-popover');
    seatingPlanner._seatDetailPopover = null;
  };
  seatingPlanner.cancelChatPending = () => {
    calls.push('chat-pending');
    seatingPlanner._chatPending = null;
  };
  seatingPlanner.toggleChat = open => {
    calls.push(`chat-${open ? 'open' : 'close'}`);
    seatingPlanner._chatExpanded = open;
  };
  seatingPlanner.updateStatus = () => calls.push('status');

  try {
    elements.set('sp-feedback-dialog', createMockElement({ hidden: false }));
    let event = createEscapeEvent();
    assert.equal(seatingPlanner.handleEscape(event), true);
    assert.deepEqual(calls.splice(0), ['feedback']);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);

    elements.set('sp-image-review', createMockElement({ hidden: false }));
    elements.set('sp-roster-bulk-panel', createMockElement({ hidden: false }));
    event = createEscapeEvent();
    assert.equal(seatingPlanner.handleEscape(event), true);
    assert.deepEqual(calls.splice(0), ['roster-bulk']);
    assert.equal(elements.get('sp-image-review').classList.contains('sp-hidden'), false);

    event = createEscapeEvent();
    assert.equal(seatingPlanner.handleEscape(event), true);
    assert.deepEqual(calls.splice(0), ['image']);

    seatingPlanner.pendingLayoutPreview = { prompt: '考试模式' };
    elements.set('sp-layout-preview-confirm', createMockElement({ hidden: false }));
    event = createEscapeEvent();
    assert.equal(seatingPlanner.handleEscape(event), true);
    assert.deepEqual(calls.splice(0), ['layout-preview']);

    elements.set('sp-context-menu', createMockElement({ hidden: true }));
    elements.get('sp-context-menu').classList.add('sp-context-menu--visible');
    event = createEscapeEvent();
    assert.equal(seatingPlanner.handleEscape(event), true);
    assert.deepEqual(calls.splice(0), ['context']);

    elements.set('seat-detail-popover', createMockElement({ hidden: false }));
    seatingPlanner._seatDetailPopover = elements.get('seat-detail-popover');
    event = createEscapeEvent();
    assert.equal(seatingPlanner.handleEscape(event), true);
    assert.deepEqual(calls.splice(0), ['seat-detail']);

    seatingPlanner._chatPending = { type: 'operations' };
    event = createEscapeEvent();
    assert.equal(seatingPlanner.handleEscape(event), true);
    assert.deepEqual(calls.splice(0), ['chat-pending']);

    seatingPlanner._chatExpanded = true;
    event = createEscapeEvent();
    assert.equal(seatingPlanner.handleEscape(event), true);
    assert.deepEqual(calls.splice(0), ['chat-close']);

    seatingPlanner.showScoreAnalysis = true;
    seatingPlanner.showArrangementExplain = true;
    event = createEscapeEvent();
    assert.equal(seatingPlanner.handleEscape(event), true);
    assert.deepEqual(calls.splice(0), ['status']);
    assert.equal(seatingPlanner.showScoreAnalysis, false);
    assert.equal(seatingPlanner.showArrangementExplain, false);

    event = createEscapeEvent();
    assert.equal(seatingPlanner.handleEscape(event), true);
    assert.deepEqual(calls.splice(0), []);
  } finally {
    Object.assign(seatingPlanner, originals);
    seatingPlanner.pendingLayoutPreview = null;
    seatingPlanner._chatPending = null;
    seatingPlanner._chatExpanded = false;
    seatingPlanner._seatDetailPopover = null;
    seatingPlanner.showScoreAnalysis = false;
    seatingPlanner.showArrangementExplain = false;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('classroom tool shell keeps active tools open when Escape reaches the launcher', async () => {
  const launcherSource = await readFile(launcherPath, 'utf8');
  const activeToolEscapeBlock = launcherSource.slice(
    launcherSource.indexOf("if (this.toolContainer.classList.contains('active'))"),
    launcherSource.indexOf("} else if (this.overlay.classList.contains('active'))")
  );

  assert.match(activeToolEscapeBlock, /currentToolInstance[\s\S]*handleEscape\(e\)/);
  assert.match(activeToolEscapeBlock, /e\.preventDefault\(\);[\s\S]*e\.stopPropagation\(\);[\s\S]*return;/);
  assert.doesNotMatch(activeToolEscapeBlock, /this\._closeTool\(\)/);
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
  const layoutPreviewSource = await readFile(layoutPreviewPanelPath, 'utf8');

  assert.match(layoutPreviewSource, /showArrangementWarnings/);
  assert.doesNotMatch(layoutPreviewSource, /if \(arrangement\.warnings\.length\) this\.showToast\(arrangement\.warnings\.join\('；'\), 'warning'\)/);
});

test('AI seating assistant is styled as a draggable floating panel with mode toggle', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const assistantSource = await readFile(assistantPanelPath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /id="sp-chat-header"/);
  assert.match(source, /grip-vertical/);
  assert.match(source, /ICeCream 座位助手/);
  assert.match(source, /aria-label="打开 ICeCream 座位助手"/);
  assert.match(source, /aria-label="关闭 ICeCream 座位助手"/);
  assert.doesNotMatch(source, />AI 座位助手</);
  assert.match(source, /seatingAssistantMethods/);
  assert.match(assistantSource, /startChatDrag/);
  assert.match(assistantSource, /syncChatPosition/);
  assert.match(styles, /\.sp-chat--positioned/);
  assert.match(styles, /--sp-chat-left/);
  assert.match(styles, /cursor: grab/);
  assert.match(styles, /background: var\(--sp-bg-surface\)/);

  // Mode toggle
  assert.match(source, /id="sp-chat-mode"/);
  assert.match(source, /data-chat-mode="auto"/);
  assert.match(source, /data-chat-mode="micro"/);
  assert.match(source, /data-chat-mode="regenerate"/);
  assert.match(assistantSource, /setChatMode/);
  assert.match(styles, /\.sp-chat-mode/);
  assert.match(styles, /\.sp-chat-mode-btn/);
});

test('seating planner uses arrange completion without static prompt chips or chat autocomplete', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const apiSource = await readFile(apiClientPath, 'utf8');
  const assistantSource = await readFile(assistantPanelPath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /id="sp-arrange-completions"/);
  assert.match(source, /id="sp-arrange-completions" class="sp-autocomplete sp-autocomplete--above sp-hidden"/);
  assert.match(source, /id="sp-complete-arrange-prompt"/);
  assert.match(source, /补全要求/);
  assert.match(source, /completeArrangePrompt/);
  assert.match(source, /pickArrangeCompletion/);
  assert.match(source, /role="listbox"/);
  assert.match(assistantSource, /setAttribute\('role', 'option'\)/);
  assert.match(source, /aria-controls="sp-arrange-completions"/);
  assert.match(source, /aria-expanded="false"/);
  assert.match(source, /seatingApi\.fetchSuggestions/);
  assert.match(assistantSource, /seatingApi\.fetchSuggestions/);
  assert.match(apiSource, /\/api\/tools\/seating\/suggestions/);
  assert.match(source, /handleSuggestionKeyDown\(e, 'arrange'\)/);
  assert.match(assistantSource, /acceptSuggestion\(kind\)/);
  assert.match(assistantSource, /hideSuggestions\(kind\)/);
  assert.match(assistantSource, /if \(event\.key === 'Escape' && open\) \{[\s\S]*event\.preventDefault\(\);\s*event\.stopPropagation\?\.\(\);[\s\S]*this\.hideSuggestions\(kind\);/);
  assert.match(assistantSource, /renderSuggestionList\(kind\)/);
  assert.match(assistantSource, /clearSuggestionState\(kind\)/);
  assert.match(source, /clearSuggestionState\('arrange'\)/);
  assert.match(assistantSource, /new AbortController\(\)/);
  assert.match(assistantSource, /setTimeout\(\(\) => this\.requestSuggestions\(kind\), immediate \? 0 : 600\)/);
  assert.doesNotMatch(source, /sp-arrange-examples/);
  assert.doesNotMatch(source, /data-arrange-example/);
  assert.doesNotMatch(source, /applyArrangeExample/);
  assert.doesNotMatch(source, /id="sp-chat-completions"/);
  assert.doesNotMatch(source, /aria-controls="sp-chat-completions"/);
  assert.doesNotMatch(source, /handleSuggestionKeyDown\(e, 'chat'\)/);
  assert.doesNotMatch(assistantSource, /scheduleSuggestionRefresh\('chat'/);
  assert.doesNotMatch(assistantSource, /clearSuggestionState\('chat'\)/);
  assert.doesNotMatch(assistantSource, /kind === 'chat'/);
  assert.doesNotMatch(assistantSource, /target: 'chat'/);
  assert.doesNotMatch(source, /input\?\.addEventListener\('input', \(\) => this\.scheduleSuggestionRefresh\('chat'\)\)/);
  assert.doesNotMatch(source, /arrangePrompt\?\.addEventListener\('input', \(\) => this\.scheduleSuggestionRefresh\('arrange'/);
  assert.doesNotMatch(source, /setInterval\(/);
  assert.doesNotMatch(source, /sp-suggestion-strip/);
  assert.match(styles, /\.sp-autocomplete/);
  assert.match(styles, /\.sp-autocomplete\s*{[^}]*position: absolute/s);
  assert.match(styles, /\.sp-autocomplete\s*{[^}]*top: calc\(100% \+ 6px\)/s);
  assert.doesNotMatch(styles, /\.sp-autocomplete\s*{[^}]*margin-top/s);
  assert.match(styles, /\.sp-autocomplete--above\s*{[^}]*top: auto/s);
  assert.match(styles, /\.sp-autocomplete--above\s*{[^}]*bottom: calc\(100% \+ 8px\)/s);
  assert.doesNotMatch(styles, /\.sp-prompt-examples/);
  assert.doesNotMatch(styles, /\.sp-prompt-example/);
  assert.doesNotMatch(styles, /\.sp-autocomplete--chat\s*{[^}]*margin:/s);
  assert.match(styles, /\.sp-autocomplete-option/);
  assert.match(styles, /\.sp-autocomplete-option\.is-active/);
});

test('seating planner renders separate confirmation copy for batch tuning and regeneration', async () => {
  const assistantSource = await readFile(assistantPanelPath, 'utf8');

  assert.match(assistantSource, /这会批量调整当前座位，但不改变布局，确认执行吗？/);
  assert.match(assistantSource, /这会重新生成座位表并可能大幅改变当前安排，确认继续吗？/);
  assert.match(assistantSource, /intent === 'batch_tune'/);
  assert.match(assistantSource, /intent === 'regenerate'/);
  assert.match(assistantSource, /guardians: this\.guardians/);
  assert.match(assistantSource, /this\.guardians = result\.guardians/);
  assert.doesNotMatch(assistantSource, /shouldUseArrangementAssistant/);
});

test('seating image import uses a review dialog before committing recognized students', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const rosterSource = await readFile(rosterPanelPath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /id="sp-image-review"/);
  assert.match(source, /识别结果确认/);
  assert.match(source, />\s*序号\s*<\/th>/);
  assert.match(source, /确认导入/);
  assert.match(source, /重新上传/);
  assert.match(source, /取消/);
  assert.match(rosterSource, /showImageReview\(result\.data/);
  assert.match(source, /confirmImageReview\(\)/);
  assert.match(rosterSource, /appendReviewedStudentsToInput/);
  assert.match(rosterSource, /sp-image-review-title/);
  assert.match(rosterSource, /识别结果确认（\$\{students\.length\}人）/);
  assert.match(rosterSource, /indexCell\.className = 'sp-image-review-index'/);
  assert.match(rosterSource, /indexCell\.textContent = String\(index \+ 1\)/);
  assert.doesNotMatch(source, /data-field="index"/);
  assert.match(styles, /\.sp-image-review/);
  assert.match(styles, /\.sp-image-review-index/);
  assert.match(styles, /\.sp-image-review-row--warning/);
  assert.match(styles, /\.sp-image-review-field--warning/);
});

test('student roster update opens the review-style editable table', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const rosterSource = await readFile(rosterPanelPath, 'utf8');

  assert.match(rosterSource, /showStudentEditor\(text/);
  assert.match(rosterSource, /this\.showStudentEditor\(text\)/);
  assert.match(rosterSource, /this\.showStudentEditor\(this\.formatStudentsForEditor\(result\.data\.students\)\)/);
  assert.match(rosterSource, /this\.showStudentEditor\(nextText\)/);
  assert.match(source, />\s*编辑名单\s*</);
  assert.match(source, /addEventListener\('click', \(\) => this\.openRosterEditor\(\)\)/);
  assert.match(rosterSource, /openRosterEditor\(\)/);
  assert.match(rosterSource, /showRosterReview\(students/);
  assert.match(rosterSource, /名单编辑（\$\{students\.length\}人）/);
  assert.match(rosterSource, /confirmRosterReview\(\)/);
  assert.match(rosterSource, /applyRosterReviewUpdate/);
  assert.match(rosterSource, /confirmButton\.textContent = '确认更新'/);
  assert.match(rosterSource, /reuploadButton\?\.classList\.add\('sp-hidden'\)/);
  assert.doesNotMatch(source, /sp-parse-students'\)\?\.addEventListener\('click', \(\) => this\.parseStudents\(\)\)/);
});

test('student roster editor supports add, bulk append, and row removal controls', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const rosterSource = await readFile(rosterPanelPath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /id="sp-roster-toolbar"/);
  assert.match(source, /id="sp-roster-add-row"/);
  assert.match(source, />\s*添加一行\s*</);
  assert.match(source, /id="sp-roster-bulk-toggle"/);
  assert.match(source, />\s*批量粘贴\s*</);
  assert.match(source, /id="sp-roster-bulk-text"/);
  assert.match(source, /id="sp-roster-bulk-append"/);
  assert.match(source, />\s*追加到表格\s*</);
  assert.match(source, /sp-roster-action-head/);
  assert.match(rosterSource, /sp-roster-delete-row/);
  assert.match(rosterSource, /addRosterReviewRow/);
  assert.match(rosterSource, /appendRosterBulkText/);
  assert.match(rosterSource, /toggleRosterBulkPanel/);
  assert.match(rosterSource, /renumberReviewRows/);
  assert.match(rosterSource, /setRosterEditorControlsVisible\(false\)/);
  assert.match(rosterSource, /setRosterEditorControlsVisible\(true\)/);
  assert.match(styles, /\.sp-roster-toolbar/);
  assert.match(styles, /\.sp-roster-bulk-panel/);
  assert.match(styles, /\.sp-roster-delete-row/);
});

test('student roster update preserves placed students and clears removed seats only', () => {
  seatingPlanner.students = [
    { id: 's01', name: '张三', gender: 'M', height: 170, grade: 80 },
    { id: 's02', name: '李四', gender: 'F', height: 165, grade: 90 },
    { id: 's03', name: '王五', gender: 'M', height: 171, grade: 70 },
  ];
  seatingPlanner._buildStudentMap();
  seatingPlanner.layout = [
    ['s01', 's02'],
    ['s03', null],
  ];
  seatingPlanner.guardians = ['s02', null];
  seatingPlanner.classroomLayout = {
    rows: 2,
    cols: 2,
    cells: [['seat', 'seat'], ['seat', 'seat']],
    groups: [[null, null], [null, null]],
    guardians: { enabled: true, left: 's02', right: null },
    template: 'custom',
    groupSize: 1,
  };
  seatingPlanner.unassigned = [];

  const update = seatingPlanner.buildRosterUpdateFromReview([
    { id: 's01', name: '张三', gender: 'M', height: 170, grade: 80 },
    { id: 's03', name: '王五', gender: 'M', height: 171, grade: 70 },
    { name: '赵六', gender: 'F', height: 160, grade: 88 },
  ]);

  assert.deepEqual(update.removedIds, ['s02']);
  assert.deepEqual(update.addedIds, ['s04']);
  assert.deepEqual(update.students.map(student => student.id), ['s01', 's03', 's04']);

  seatingPlanner.applyRosterReviewState(update);

  assert.equal(seatingPlanner.layout[0][0], 's01');
  assert.equal(seatingPlanner.layout[0][1], null);
  assert.equal(seatingPlanner.layout[1][0], 's03');
  assert.deepEqual(seatingPlanner.guardians, [null, null]);
  assert.equal(seatingPlanner.classroomLayout.guardians.left, null);
  assert.deepEqual(seatingPlanner.unassigned, ['s04']);
});

test('arrange prompt typography matches student needs input', async () => {
  const styles = await readFile(stylePath, 'utf8');

  assert.match(styles, /\.sp-arrange-prompt\s*{[^}]*padding: var\(--sp-space-sm\) var\(--sp-space-md\)/s);
  assert.match(styles, /\.sp-arrange-prompt\s*{[^}]*border-radius: var\(--sp-radius-md\)/s);
  assert.match(styles, /\.sp-arrange-prompt\s*{[^}]*font-size: 0\.85rem/s);
  assert.match(styles, /\.sp-arrange-prompt\s*{[^}]*font-family: inherit/s);
  assert.match(styles, /\.sp-arrange-prompt\s*{[^}]*line-height: 1\.6/s);
  assert.match(styles, /\.sp-arrange-prompt::placeholder\s*{[^}]*color: var\(--sp-text-muted\)/s);
  assert.match(styles, /\.sp-arrange-prompt::placeholder\s*{[^}]*opacity: 0\.7/s);
});

test('autocomplete suggestions follow the active light and dark theme', async () => {
  const styles = await readFile(stylePath, 'utf8');

  assert.match(styles, /\.sp-autocomplete\s*{[^}]*background: var\(--sp-bg-surface\)/s);
  assert.match(styles, /\.sp-autocomplete\s*{[^}]*border: 1px solid var\(--sp-border\)/s);
  assert.match(styles, /body\.light-mode \.sp-autocomplete\s*{/);
  assert.match(styles, /body\.light-mode \.sp-autocomplete-option\.is-active/);
});

test('blackboard text uses Times New Roman for Latin characters', async () => {
  const styles = await readFile(stylePath, 'utf8');

  assert.match(styles, /\.sp-chalk-text\s*{[^}]*font-family: 'Times New Roman'/s);
  assert.match(styles, /\.sp-blackboard-notes\s*{[^}]*font-family: 'Times New Roman'/s);
});

test('chat requests delegate intent classification to the backend', async () => {
  const assistantSource = await readFile(assistantPanelPath, 'utf8');
  const apiSource = await readFile(apiClientPath, 'utf8');

  assert.match(assistantSource, /seatingApi\.fetchChat/);
  assert.match(apiSource, /\/api\/tools\/seating\/chat/);
  assert.match(assistantSource, /const intent = data\.intent/);
  assert.match(assistantSource, /intent === 'direct_edit'/);
  assert.match(assistantSource, /intent === 'batch_tune'/);
  assert.match(assistantSource, /intent === 'regenerate'/);
  assert.doesNotMatch(assistantSource, /shouldUseArrangementAssistant/);
  assert.doesNotMatch(assistantSource, /detectSeatingMutationIntent/);
});

test('major chat arrangement requests require confirmation before regenerating seats', async () => {
  const assistantSource = await readFile(assistantPanelPath, 'utf8');

  assert.match(assistantSource, /showChatPendingConfirmation\(data\.confirmationText/);
  assert.match(assistantSource, /confirmMajorArrangementFromChat/);
  assert.match(assistantSource, /这会重新生成座位表并可能大幅改变当前安排，确认继续吗？/);
  assert.match(assistantSource, /this\._chatPending\s*=\s*{\s*type: 'arrangement'/s);
  assert.doesNotMatch(assistantSource, /showChatArrangementConfirmation/);
});

test('seating planner inserts full row and column aisles from gap handles', async () => {
  const gridSource = await readFile(gridPanelPath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(gridSource, /renderAisleGapHandles/);
  assert.match(gridSource, /localAisles/);
  assert.match(gridSource, /shouldShowRowAisleBoundary/);
  assert.match(gridSource, /shouldShowColumnAisleBoundary/);
  assert.match(gridSource, /this\.insertAisleRowAt\(row\)/);
  assert.match(gridSource, /this\.insertAisleColumnAt\(col\)/);
  assert.match(gridSource, /this\.pendingLayoutPreview\.classroomLayout = structuredClone\(this\.classroomLayout\)/);
  assert.match(gridSource, /this\.renderPrimaryLayoutPreviewSummary\?\.\(\)/);
  assert.match(styles, /\.sp-aisle-gap/);
});

test('seating planner exports local PNG and styled xlsx', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const apiSource = await readFile(apiClientPath, 'utf8');
  const exportSource = await readFile(exportPanelPath, 'utf8');

  assert.match(source, /seatingExportMethods/);
  assert.match(exportSource, /ensureHtml2Canvas/);
  assert.match(exportSource, /\/js\/libs\/html2canvas\.min\.js/);
  assert.match(exportSource, /html2canvas-retry/);
  assert.match(exportSource, /typeof window\.html2canvas !== 'function'/);
  assert.match(exportSource, /suppressHtml2CanvasAmdRegistration/);
  assert.match(exportSource, /amdDefine\.amd = undefined/);
  assert.match(exportSource, /amdDefine\.amd = previousAmd/);
  assert.match(exportSource, /sp-export-hide/);
  assert.match(source, /exportXLSX/);
  assert.match(exportSource, /seatingApi\.fetchExportXlsx/);
  assert.match(apiSource, /\/api\/tools\/seating\/export-xlsx/);
  assert.match(exportSource, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.doesNotMatch(source, /sp-export-excel'\)\?\.addEventListener\('click', \(\) => this\.exportCSV\(\)\)/);
});

test('seating planner shows score summary and expandable score analysis in the status bar', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /evaluateSeatingQuality/);
  assert.match(source, /sp-toggle-score-analysis/);
  assert.match(source, /renderScoreAnalysisPanel/);
  assert.match(source, /评分 \$\{quality\.percent\} · \$\{quality\.feasible \? '可行' : '需调整'\}/);
  assert.match(source, /highlightScoreIssue/);
  assert.match(source, /highlightSingleMatch/);
  assert.match(source, /formatScoreMatchDetail/);
  assert.match(source, /aria-expanded/);
  assert.match(source, /sp-score-analysis-legend/);
  assert.match(source, /matchButton\.addEventListener\('click', event => \{\s*event\.stopPropagation\(\);\s*this\.highlightSingleMatch\(match\);/s);
  assert.match(source, /sp-score-analysis-match/);
  assert.match(source, /issue\.matches\.forEach/);
  assert.doesNotMatch(source, /shownMatches/);
  assert.doesNotMatch(source, /slice\(0, 4\)/);
  assert.doesNotMatch(source, /还有 \$\{issue\.matches\.length - shownMatches\.length\} 项/);
  assert.match(source, /sp-score-analysis/);
  assert.match(styles, /\.sp-score-analysis/);
  assert.match(styles, /\.sp-score-analysis\s*{[^}]*max-height: min\(36vh, 360px\)/s);
  assert.match(styles, /\.sp-score-analysis\s*{[^}]*overflow-y: auto/s);
  assert.match(styles, /\.sp-score-analysis-detail\s*{[^}]*white-space: normal/s);
  assert.match(styles, /\.sp-score-analysis-match\s*{[^}]*overflow-wrap: anywhere/s);
  assert.match(styles, /\.sp-score-analysis-item/);
  assert.match(styles, /\.sp-score-analysis-item-header/);
  assert.match(styles, /\.sp-score-analysis-legend/);
});

test('seating planner renders a compact horizontal status bar with warning chip', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /sp-status-left/);
  assert.match(source, /sp-status-middle/);
  assert.match(source, /sp-status-right/);
  assert.match(source, /sp-status-warning-chip/);
  assert.match(source, /buildCompactStatusWarning\(unplacedCount\)/);
  assert.match(source, /activateStatusWarningChip\(warning\)/);
  assert.match(source, /statusWarningChip\.addEventListener\('click'/);
  assert.match(source, /this\.showScoreAnalysis = true/);
  assert.match(source, /评分 \$\{quality\.percent\} · \$\{quality\.feasible \? '可行' : '需调整'\}/);
  assert.match(source, /满足 \$\{evaluation\.satisfied\}\/\$\{evaluation\.total\} 需求/);
  assert.match(source, /this\.renderSeatDetailsToggle\(\)/);
  assert.match(source, /querySelector\('#sp-status \.sp-status-right'\)/);
  assert.doesNotMatch(source, /sp-status-primary/);
  assert.doesNotMatch(source, /sp-status-needs-bar/);
  assert.doesNotMatch(source, /sp-status-warnings/);
  assert.doesNotMatch(source, /sp-status-needs-fill/);

  assert.match(styles, /\.sp-status\s*{[^}]*display:\s*flex/s);
  assert.match(styles, /\.sp-status-left/);
  assert.match(styles, /\.sp-status-middle/);
  assert.match(styles, /\.sp-status-right/);
  assert.match(styles, /\.sp-status-chip/);
  assert.match(styles, /\.sp-status-warning-chip/);
  assert.doesNotMatch(styles, /grid-template-areas:\s*[\s\S]*warnings warnings warnings/);
  assert.doesNotMatch(styles, /\.sp-status-warnings/);
  assert.doesNotMatch(styles, /\.sp-status-needs-bar/);
});

test('seating planner explains parsed physical rows and mixed column layouts', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /layoutFacts\.physicalRows/);
  assert.match(source, /layoutFacts\.columnPattern/);
  assert.match(source, /layoutFacts\.capacityPolicy/);
  assert.match(source, /mixedColumnPattern/);
  assert.match(source, /两边1人组，中间2人组/);
});

test('collapsed AI seating assistant icon can be dragged without opening the panel', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const assistantSource = await readFile(assistantPanelPath, 'utf8');

  assert.match(assistantSource, /startChatIconDrag/);
  assert.match(source, /CHAT_DRAG_THRESHOLD/);
  assert.match(assistantSource, /suppressChatToggleClick/);
  assert.match(assistantSource, /toggle\?\.addEventListener\('pointerdown', e => this\.startChatIconDrag\(e\)\)/);
});

test('arrange prompt completion stays manual without static examples or automatic opening', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const assistantSource = await readFile(assistantPanelPath, 'utf8');

  assert.match(source, /_arrangeSuggestionDismissedText/);
  assert.match(assistantSource, /scheduleSuggestionRefresh\(kind, immediate = false, options = \{\}\)/);
  assert.doesNotMatch(source, /sp-arrange-examples/);
  assert.doesNotMatch(source, /applyArrangeExample/);
  assert.doesNotMatch(source, /source: 'input'/);
  assert.match(source, /arrangePrompt\?\.addEventListener\('input', \(\) => this\.handleArrangementPromptInput\?\.\(\)\)/);
  assert.doesNotMatch(source, /arrangePrompt\?\.addEventListener\('focus', \(\) => this\.scheduleSuggestionRefresh\('arrange', true\)\)/);
  assert.doesNotMatch(source, /scheduleSuggestionRefresh\('arrange', true\)/);
});
