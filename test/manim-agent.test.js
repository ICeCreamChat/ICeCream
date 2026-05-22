import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';
import {
  buildAgentPayload,
  formatManimStreamError,
  getManimAgentStreamTimeoutMs,
  isManimAgentEnabled,
} from '../services/manim/manim-client.js';

const codePanelPath = new URL('../public/js/core/code-panel.js', import.meta.url);
const messageHandlerPath = new URL('../public/js/core/message-handler.js', import.meta.url);
const intentConfirmPath = new URL('../public/js/core/intent-confirm.js', import.meta.url);
const manimWorkbenchPath = new URL('../public/js/core/manim-workbench.js', import.meta.url);
const manimSketchPadPath = new URL('../public/js/core/manim-sketch-pad.js', import.meta.url);
const appPath = new URL('../public/js/app.js', import.meta.url);
const indexPath = new URL('../public/index.html', import.meta.url);
const mainCssPath = new URL('../public/css/main.css', import.meta.url);
const mobileCssPath = new URL('../public/css/mobile.css', import.meta.url);
const studioCanvasPath = new URL('../src/manim-studio/main.jsx', import.meta.url);
const studioBundlePath = new URL('../public/js/studio/manim-studio-canvas.js', import.meta.url);

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function withGatewayAndManim(handler, run) {
  const originalUrl = process.env.MANIM_SERVICE_URL;
  const originalEnabled = process.env.MANIM_AGENT_ENABLED;
  const manimServer = createServer(handler);
  const manimBase = await listen(manimServer);
  process.env.MANIM_SERVICE_URL = manimBase;
  process.env.MANIM_AGENT_ENABLED = 'true';

  const appServer = createGatewayApp({ isDev: false }).listen(0, '127.0.0.1');
  const appBase = await new Promise(resolve => {
    appServer.on('listening', () => {
      const address = appServer.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  try {
    await run(appBase);
  } finally {
    await close(appServer);
    await close(manimServer);
    restoreEnv('MANIM_SERVICE_URL', originalUrl);
    restoreEnv('MANIM_AGENT_ENABLED', originalEnabled);
  }
}

test('Manim agent payload normalizes create and modify requests', () => {
  assert.equal(isManimAgentEnabled({}), true);
  assert.equal(isManimAgentEnabled({ MANIM_AGENT_ENABLED: 'false' }), false);

  assert.deepEqual(buildAgentPayload({
    message: '画一个流程图',
    client_id: 'classroom/1',
    skillIds: ['flow_explanation'],
    referenceImageIds: ['ref-1'],
    jobId: 'job-1',
  }), {
    message: '画一个流程图',
    mode: 'create',
    currentCode: '',
    clientId: 'classroom_1',
    skillIds: ['flow_explanation'],
    referenceImageIds: ['ref-1'],
    jobId: 'job-1',
  });

  assert.deepEqual(buildAgentPayload({
    message: '把圆改成红色',
    code: 'Circle()',
    type: 'modification',
    clientId: 'panel',
  }), {
    message: '把圆改成红色',
    mode: 'modify',
    currentCode: 'Circle()',
    clientId: 'panel',
    skillIds: [],
    referenceImageIds: [],
    jobId: '',
  });
});

test('Manim agent stream timeout and abort errors are user-facing Chinese', () => {
  assert.equal(getManimAgentStreamTimeoutMs({}), 1200000);
  assert.equal(getManimAgentStreamTimeoutMs({ MANIM_AGENT_STREAM_TIMEOUT_MS: '120000' }), 600000);
  assert.equal(getManimAgentStreamTimeoutMs({ MANIM_AGENT_STREAM_TIMEOUT_MS: '420' }), 600000);
  assert.equal(getManimAgentStreamTimeoutMs({ MANIM_AGENT_STREAM_TIMEOUT_MS: '900' }), 900000);

  const message = formatManimStreamError({ name: 'AbortError', message: 'The operation was aborted.' });
  assert.equal(message, '生成超时，Manim 服务仍可能在后台渲染，请稍后重试');
  assert.doesNotMatch(message, /aborted/i);
});

test('POST /api/manim uses Manim agent run endpoint', async () => {
  let observedRequest;

  await withGatewayAndManim((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      observedRequest = {
        method: req.method,
        url: req.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: true,
        intent: 'manim',
        rendered: true,
        code: 'from manim import *',
        videoUrl: '/static/video.mp4',
        agentTrace: { codeSource: 'llm_v6', template: 'none', skills: ['flow_explanation'], retries: 0 },
      }));
    });
  }, async appBase => {
    const response = await fetch(`${appBase}/api/manim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '画一个流程图', client_id: 'abc' }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(observedRequest.method, 'POST');
    assert.equal(observedRequest.url, '/agent/run');
    assert.equal(observedRequest.body.mode, 'create');
    assert.equal(observedRequest.body.message, '画一个流程图');
    assert.equal(payload.rendered, true);
    assert.equal(payload.agentTrace.codeSource, 'llm_v6');
    assert.equal(payload.agentTrace.template, 'none');
  });
});

test('POST /api/manim/agent/stream proxies v6 NDJSON agent events', async () => {
  let observedRequest;

  await withGatewayAndManim((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      observedRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.write(JSON.stringify({ type: 'job', job: { jobId: 'job-123', status: 'running', currentStage: 'planner' } }) + '\n');
      res.write(JSON.stringify({ type: 'progress', step: 'planner', message: 'planning' }) + '\n');
      res.write(JSON.stringify({
        type: 'reference',
        status: 'pass',
        summary: '检测到 1 个画面中心的圆形主体，建议用干净的 Manim 图形重绘。',
        references: [{ referenceId: 'ref-1', filename: 'sketch.png' }],
        referenceSpecs: [{ referenceId: 'ref-1', status: 'pass', summary: '检测到 1 个画面中心的圆形主体' }],
      }) + '\n');
      res.write(JSON.stringify({ type: 'design', design: { status: 'success' } }) + '\n');
      res.write(JSON.stringify({ type: 'storyboard', storyboard: [{ title: 'step' }] }) + '\n');
      res.write(JSON.stringify({ type: 'style', style: { name: 'teaching_premium' } }) + '\n');
      res.write(JSON.stringify({ type: 'patch_plan', patchPlan: { summary: '保持主体，修改颜色', operations: ['update color'] } }) + '\n');
      res.write(JSON.stringify({ type: 'skill_activation', skills: [{ id: 'flow_explanation', name: '流程解释' }] }) + '\n');
      res.write(JSON.stringify({ type: 'code_delta', delta: 'from manim import *', code: 'from manim import *', source: 'llm_v6' }) + '\n');
      res.write(JSON.stringify({ type: 'static_guard', guard: { status: 'pass', summary: 'Python 静态守卫通过。' } }) + '\n');
      res.write(JSON.stringify({ type: 'visual_check', visual: { status: 'pass' } }) + '\n');
      res.write(JSON.stringify({ type: 'cache', status: 'miss', summary: '未命中渲染缓存' }) + '\n');
      res.end(JSON.stringify({ type: 'result', success: true, intent: 'manim', rendered: false, code: 'from manim import *' }) + '\n');
    });
  }, async appBase => {
    const response = await fetch(`${appBase}/api/manim/agent/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '解释牛顿第二定律', mode: 'create' }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.equal(observedRequest.message, '解释牛顿第二定律');
    assert.equal(observedRequest.mode, 'create');
    assert.match(text, /"type":"progress"/);
    assert.match(text, /"type":"job"/);
    assert.match(text, /"type":"reference"/);
    assert.match(text, /referenceSpecs/);
    assert.match(text, /"type":"design"/);
    assert.match(text, /"type":"storyboard"/);
    assert.match(text, /"type":"style"/);
    assert.match(text, /"type":"patch_plan"/);
    assert.match(text, /"type":"skill_activation"/);
    assert.match(text, /"type":"code_delta"/);
    assert.match(text, /"type":"static_guard"/);
    assert.match(text, /"type":"visual_check"/);
    assert.match(text, /"type":"cache"/);
    assert.match(text, /"type":"result"/);
  });
});

test('Gateway proxies v6 Manim jobs, failures, replay, and reference image APIs', async () => {
  const observed = [];

  await withGatewayAndManim((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      observed.push({ method: req.method, url: req.url, body: bodyText ? JSON.parse(bodyText) : null });
      res.setHeader('Content-Type', 'application/json');

      if (req.url.startsWith('/agent/jobs?')) {
        res.end(JSON.stringify({ success: true, jobs: [{ jobId: 'job-1' }] }));
      } else if (req.url === '/agent/skills') {
        res.end(JSON.stringify({ success: true, version: 'manim-v6-skills', skills: [{ id: 'geometry', name: '几何图形', guidance: '清晰线条' }] }));
      } else if (req.url === '/agent/jobs/job-1') {
        res.end(JSON.stringify({ success: true, job: { jobId: 'job-1', status: 'running' } }));
      } else if (req.url === '/agent/jobs/job-1/cancel') {
        res.end(JSON.stringify({ success: true, job: { jobId: 'job-1', status: 'cancelled' } }));
      } else if (req.url.startsWith('/agent/failures?')) {
        res.end(JSON.stringify({ success: true, failures: [{ eventId: 'fail-1' }] }));
      } else if (req.url === '/agent/failures/fail-1/replay') {
        res.end(JSON.stringify({ success: true, replay: { eventId: 'fail-1', status: 'pass' } }));
      } else if (req.url === '/agent/reference-images') {
        res.end(JSON.stringify({ success: true, reference: { referenceId: 'ref-1', filename: 'sketch.png' } }));
      } else if (req.url === '/agent/patch') {
        res.end(JSON.stringify({ success: true, code: `${observed.at(-1)?.body?.code || ''}\n# patched`, patchSummary: '已应用交互修复' }));
      } else if (req.url === '/agent/layout-rebuild') {
        res.end(JSON.stringify({
          success: true,
          code: `${observed.at(-1)?.body?.code || ''}\n# layout rebuilt`,
          videoUrl: '/static/video_rebuilt.mp4',
          runtimeSceneManifest: { objects: [] },
          studioFrameSet: { recommendedFrameId: 'frame_03', frames: [{ frameId: 'frame_03', imageUrl: '/static/frame_03.png' }] },
        }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, error: req.url }));
      }
    });
  }, async appBase => {
    const skills = await (await fetch(`${appBase}/api/manim/skills`)).json();
    const jobs = await (await fetch(`${appBase}/api/manim/jobs?limit=2`)).json();
    const job = await (await fetch(`${appBase}/api/manim/jobs/job-1`)).json();
    const cancel = await (await fetch(`${appBase}/api/manim/jobs/job-1/cancel`, { method: 'POST' })).json();
    const failures = await (await fetch(`${appBase}/api/manim/failures?limit=3`)).json();
    const replay = await (await fetch(`${appBase}/api/manim/failures/fail-1/replay`, { method: 'POST' })).json();
    const reference = await (await fetch(`${appBase}/api/manim/reference-images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'sketch.png', mimeType: 'image/png', dataBase64: 'abc' }),
    })).json();
    const patch = await (await fetch(`${appBase}/api/manim/patch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'title = Text("旧标题")', patch: { operation: 'replace_text', objectId: 'title', text: '新标题' } }),
    })).json();

    const layout = await (await fetch(`${appBase}/api/manim/layout-rebuild`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'title = Text("old")',
        layoutEditSpec: {
          baseFrameId: 'frame_03',
          edits: [{ operation: 'move', objectId: 'title', normalizedBBox: { x: 0.2, y: 0.2, width: 0.2, height: 0.1 } }],
        },
      }),
    })).json();

    assert.equal(skills.skills[0].id, 'geometry');
    assert.equal(jobs.jobs[0].jobId, 'job-1');
    assert.equal(job.job.status, 'running');
    assert.equal(cancel.job.status, 'cancelled');
    assert.equal(failures.failures[0].eventId, 'fail-1');
    assert.equal(replay.replay.status, 'pass');
    assert.equal(reference.reference.referenceId, 'ref-1');
    assert.match(patch.code, /patched/);
    assert.match(layout.code, /layout rebuilt/);
    assert.equal(layout.studioFrameSet.recommendedFrameId, 'frame_03');
  });

  assert.deepEqual(observed.map(item => `${item.method} ${item.url}`), [
    'GET /agent/skills',
    'GET /agent/jobs?limit=2',
    'GET /agent/jobs/job-1',
    'POST /agent/jobs/job-1/cancel',
    'GET /agent/failures?limit=3',
    'POST /agent/failures/fail-1/replay',
    'POST /agent/reference-images',
    'POST /agent/patch',
    'POST /agent/layout-rebuild',
  ]);
  assert.equal(observed.at(-3).body.filename, 'sketch.png');
  assert.equal(observed.at(-2).body.patch.operation, 'replace_text');
  assert.equal(observed.at(-1).body.layoutEditSpec.baseFrameId, 'frame_03');
});

test('frontend shows Manim agent v6 production progress in a chat bubble', async () => {
  const [messageHandlerSource, manimWorkbenchSource, manimSketchPadSource, appSource, mainCssSource, mobileCssSource] = await Promise.all([
    readFile(messageHandlerPath, 'utf8'),
    readFile(manimWorkbenchPath, 'utf8'),
    readFile(manimSketchPadPath, 'utf8'),
    readFile(appPath, 'utf8'),
    readFile(mainCssPath, 'utf8'),
    readFile(mobileCssPath, 'utf8'),
  ]);

  assert.match(appSource, /manimWorkbench/);
  assert.match(appSource, /messageHandler\.init\(\{[\s\S]*manimWorkbench: this\.manimWorkbench/);
  assert.match(appSource, /this\.manimWorkbench\?\.setMode\(mode\)/);
  assert.match(messageHandlerSource, /manimWorkbench/);
  assert.match(messageHandlerSource, /getAgentOptions/);
  assert.match(messageHandlerSource, /handleAgentEvent/);
  assert.match(messageHandlerSource, /handleAgentResult/);
  assert.match(messageHandlerSource, /skillIds:\s*payload\.skillIds/);
  assert.match(messageHandlerSource, /referenceImageIds:\s*payload\.referenceImageIds/);

  assert.match(manimWorkbenchSource, /class ManimWorkbench/);
  assert.match(manimWorkbenchSource, /manim-workbench-btn/);
  assert.match(manimWorkbenchSource, /manim-workbench-panel/);
  assert.match(manimWorkbenchSource, /\/api\/manim\/skills/);
  assert.match(manimWorkbenchSource, /\/api\/manim\/reference-images/);
  assert.match(manimWorkbenchSource, /\/api\/manim\/jobs/);
  assert.match(manimWorkbenchSource, /\/api\/manim\/failures/);
  assert.match(manimWorkbenchSource, /getAgentOptions/);
  assert.match(manimWorkbenchSource, /skillIds/);
  assert.match(manimWorkbenchSource, /referenceImageIds/);
  assert.match(manimWorkbenchSource, /cancelCurrentJob/);
  assert.match(manimWorkbenchSource, /currentJob/);
  assert.doesNotMatch(manimWorkbenchSource, /recentJobs/);
  assert.doesNotMatch(manimWorkbenchSource, /mergeRecentJob/);
  assert.match(manimWorkbenchSource, /if \(!current\?\.jobId\) return ''/);
  assert.match(manimWorkbenchSource, /replayFailure/);
  assert.match(manimWorkbenchSource, /setMode\(mode\)/);
  assert.match(manimWorkbenchSource, /captureSessionFailure/);
  assert.match(manimWorkbenchSource, /mergeReferenceAnalysis/);
  assert.match(manimWorkbenchSource, /analysisSummary/);
  assert.match(manimWorkbenchSource, /analysisStatus/);
  assert.match(manimWorkbenchSource, /renderDebugDiagnosticsSection/);
  assert.match(manimWorkbenchSource, /resetSessionRuntime/);
  assert.match(appSource, /this\.manimWorkbench\?\.resetSessionRuntime\?\.\(\)/);
  assert.match(manimWorkbenchSource, /icecream_manim_debug/);
  assert.match(manimWorkbenchSource, /isDebugMode\(\)/);
  assert.match(manimWorkbenchSource, /sessionFailures/);
  assert.match(manimWorkbenchSource, /globalFailuresLoaded/);
  assert.match(manimWorkbenchSource, /当前会话暂无失败记录/);
  assert.match(manimWorkbenchSource, /全局失败样本不会自动展示/);
  assert.match(manimWorkbenchSource, /加载全局失败样本/);
  const initialLoadBody = manimWorkbenchSource.match(/async loadInitialData\(\) \{([\s\S]*?)\n    \}/)?.[1] || '';
  assert.doesNotMatch(initialLoadBody, /loadFailures/);
  assert.doesNotMatch(initialLoadBody, /loadJobs/);
  assert.match(manimWorkbenchSource, /WORKBENCH_POSITION_KEY/);
  assert.match(manimWorkbenchSource, /initDragControls/);
  assert.match(manimWorkbenchSource, /handleDragStart/);
  assert.match(manimWorkbenchSource, /handleDragMove/);
  assert.match(manimWorkbenchSource, /handleDragEnd/);
  assert.match(manimWorkbenchSource, /clampWorkbenchPosition/);
  assert.match(manimWorkbenchSource, /loadWorkbenchPosition/);
  assert.match(manimWorkbenchSource, /saveWorkbenchPosition/);
  assert.match(manimWorkbenchSource, /resetWorkbenchPosition/);
  assert.match(manimWorkbenchSource, /manim-workbench-header/);
  assert.doesNotMatch(manimWorkbenchSource, /body\.addEventListener\('pointerdown'/);
  assert.match(manimWorkbenchSource, /动画工作台/);
  assert.match(manimWorkbenchSource, /生成设置/);
  assert.match(manimWorkbenchSource, /参考素材/);
  assert.match(manimWorkbenchSource, /当前任务/);
  assert.match(manimWorkbenchSource, /仅显示本次会话/);
  assert.match(manimWorkbenchSource, /开发诊断/);
  assert.match(manimWorkbenchSource, /仅调试使用/);
  assert.doesNotMatch(manimWorkbenchSource, /任务状态/);
  assert.doesNotMatch(manimWorkbenchSource, /诊断记录/);
  assert.doesNotMatch(manimWorkbenchSource, /最近任务/);
  assert.doesNotMatch(manimWorkbenchSource, /data-action="refresh-jobs"/);
  assert.match(manimWorkbenchSource, /manim-reference-dropzone/);
  assert.match(manimWorkbenchSource, /manim-config-summary/);
  assert.match(manimWorkbenchSource, /上传参考图/);
  assert.match(manimWorkbenchSource, /在线手绘/);
  assert.match(manimWorkbenchSource, /draw-reference/);
  assert.match(manimWorkbenchSource, /openSketchPad/);
  assert.match(manimWorkbenchSource, /uploadSketchReferences/);
  assert.match(manimWorkbenchSource, /ManimSketchPad/);
  assert.match(manimSketchPadSource, /class ManimSketchPad/);
  assert.match(manimSketchPadSource, /Pointer Events|pointerdown/);
  assert.match(manimSketchPadSource, /renderToolButton\('pen'/);
  assert.match(manimSketchPadSource, /renderToolButton\('eraser'/);
  assert.match(manimSketchPadSource, /tool-\$\{this\.tool\}/);
  assert.match(manimSketchPadSource, /Shift 拉直线段 · Ctrl\+Z 撤销/);
  assert.match(manimSketchPadSource, /handleKeydown/);
  assert.match(manimSketchPadSource, /ctrlKey \|\| event\.metaKey/);
  assert.match(manimSketchPadSource, /key === 'z'/);
  assert.match(manimSketchPadSource, /event\.shiftKey/);
  assert.match(manimSketchPadSource, /straight: Boolean\(event\.shiftKey\)/);
  assert.match(manimSketchPadSource, /data-sketch-action="undo"/);
  assert.match(manimSketchPadSource, /data-sketch-action="redo"/);
  assert.match(manimSketchPadSource, /data-sketch-action="clear"/);
  assert.match(manimSketchPadSource, /data-sketch-action="width"/);
  assert.match(manimSketchPadSource, /加入参考素材/);
  assert.match(manimSketchPadSource, /请先画一点内容/);
  assert.match(manimSketchPadSource, /toDataURL\('image\/png'\)/);
  assert.match(manimSketchPadSource, /手绘参考图-/);

  assert.match(messageHandlerSource, /event\.type === 'plan'/);
  assert.match(messageHandlerSource, /event\.type === 'job'/);
  assert.match(messageHandlerSource, /event\.type === 'reference'/);
  assert.match(messageHandlerSource, /referenceSpecs/);
  assert.match(messageHandlerSource, /process\.clarification/);
  assert.match(messageHandlerSource, /renderManimClarificationPanel/);
  assert.match(messageHandlerSource, /handleManimClarificationChoice/);
  assert.match(messageHandlerSource, /restartManimProcessInPlace/);
  assert.match(messageHandlerSource, /reuseProcess:\s*true/);
  assert.match(messageHandlerSource, /sendManimAgentStream\(payload,\s*options = \{\}/);
  assert.doesNotMatch(messageHandlerSource, /this\.handleSend\(\{ routeMode: 'manim', skipRouteGuard: true \}\)/);
  assert.match(messageHandlerSource, /manim-clarification-panel/);
  assert.match(messageHandlerSource, /manim-clarification-option/);
  assert.match(messageHandlerSource, /this\.updateManimProcessFromEvent\(\{ type: 'clarification'/);
  assert.doesNotMatch(messageHandlerSource, /this\.showManimClarification\(event\.clarification\)/);
  assert.match(messageHandlerSource, /已解析参考素材/);
  assert.match(messageHandlerSource, /event\.type === 'design'/);
  assert.match(messageHandlerSource, /event\.type === 'storyboard'/);
  assert.match(messageHandlerSource, /event\.type === 'style'/);
  assert.match(messageHandlerSource, /event\.type === 'skills'/);
  assert.match(messageHandlerSource, /event\.type === 'skill_activation'/);
  assert.match(messageHandlerSource, /event\.type === 'patch_plan'/);
  assert.match(messageHandlerSource, /event\.type === 'cache'/);
  assert.match(messageHandlerSource, /event\.type === 'inspect'/);
  assert.match(messageHandlerSource, /event\.type === 'static_guard'/);
  assert.match(messageHandlerSource, /latestManimStaticGuard/);
  assert.match(messageHandlerSource, /event\.type === 'critic_report'/);
  assert.match(messageHandlerSource, /event\.type === 'preview'/);
  assert.match(messageHandlerSource, /event\.type === 'visual_check'/);
  assert.match(messageHandlerSource, /event\.type === 'repair'/);
  assert.match(messageHandlerSource, /event\.type === 'quality_report'/);
  assert.match(messageHandlerSource, /event\.type === 'code_delta'/);
  assert.match(messageHandlerSource, /latestManimAgentCode/);
  assert.match(messageHandlerSource, /createManimProcessBubble/);
  assert.match(messageHandlerSource, /updateManimProcessFromEvent/);
  assert.match(messageHandlerSource, /formatManimQualityDetails/);
  assert.match(messageHandlerSource, /formatManimVisualDetails/);
  assert.match(messageHandlerSource, /formatManimCriticDetails/);
  assert.match(messageHandlerSource, /localizeManimText/);
  assert.match(messageHandlerSource, /localizeManimSkill/);
  assert.match(messageHandlerSource, /localizeManimError/);
  assert.match(messageHandlerSource, /函数图像教学/);
  assert.match(messageHandlerSource, /质量检查通过/);
  assert.match(messageHandlerSource, /正在修复视觉质量问题/);
  assert.match(messageHandlerSource, /生成时间过长，连接已中断/);
  assert.match(messageHandlerSource, /Simplify the animation or split it into fewer steps/);
  assert.match(messageHandlerSource, /简化动画，或减少分镜步骤/);
  assert.match(messageHandlerSource, /Use VGroup\(\.\.\.\)\.arrange\(\) and scale the group to fit the frame/);
  assert.match(messageHandlerSource, /缩放到安全画幅内/);
  assert.match(messageHandlerSource, /Setup Axes/);
  assert.match(messageHandlerSource, /建立坐标系/);
  assert.match(messageHandlerSource, /Draw Cosine Curve/);
  assert.match(messageHandlerSource, /Mobject\\\.__getattr__/);
  assert.match(messageHandlerSource, /Only values of type VMobject/);
  assert.match(messageHandlerSource, /Manim 不支持的参数/);
  assert.match(messageHandlerSource, /VGroup 中混入/);
  assert.match(messageHandlerSource, /Premature close/);
  assert.match(messageHandlerSource, /预览通道提前关闭/);
  assert.match(messageHandlerSource, /绘制余弦曲线/);
  assert.match(messageHandlerSource, /预览渲染失败：/);
  assert.match(messageHandlerSource, /代码必须只有一个可渲染 Scene 类/);
  assert.match(messageHandlerSource, /Python 静态守卫完成/);
  assert.doesNotMatch(messageHandlerSource, /动画渲染服务未响应/);
  assert.doesNotMatch(messageHandlerSource, /请确保 Manim 服务正在运行/);
  assert.match(messageHandlerSource, /const hasProblem = event\.success === false \|\| !event\.rendered \|\| Boolean\(event\.warning\)/);
  assert.match(messageHandlerSource, /setManimProcessStep\('repair', event\.warning \? 'warning' : 'active'/);
  assert.match(messageHandlerSource, /localizeManimText\(report\.summary\)/);
  assert.doesNotMatch(messageHandlerSource, /\$\{name\}：\$\{skill\.guidance\}/);
  assert.doesNotMatch(messageHandlerSource, /details\.push\(report\.summary\)/);
  assert.match(messageHandlerSource, /setManimBottomLoadingVisible\(false\)/);
  assert.match(messageHandlerSource, /manim-process-card/);
  assert.match(messageHandlerSource, /manim-studio-card/);
  assert.match(messageHandlerSource, /manim-studio-result/);
  assert.match(messageHandlerSource, /is-current/);
  assert.match(messageHandlerSource, /getVisibleManimDetailSteps/);
  assert.match(messageHandlerSource, /getVisibleManimDetailSteps\(process\) \{\s*return process\.steps;/);
  assert.doesNotMatch(messageHandlerSource, /getPinnedManimDetailStepIds/);
  assert.doesNotMatch(messageHandlerSource, /pinnedIds\.has\(step\.id\)/);
  assert.match(messageHandlerSource, /暂未开始，等待前序步骤完成/);
  assert.match(messageHandlerSource, /pending:\s*'暂未开始'/);
  assert.match(messageHandlerSource, /is-focus/);
  assert.match(messageHandlerSource, /作品预览/);
  assert.match(messageHandlerSource, /isMessagesNearBottom/);
  assert.match(messageHandlerSource, /bindMessagesUserScrollGuard/);
  assert.match(messageHandlerSource, /lockManimAutoScroll/);
  assert.match(messageHandlerSource, /isManimAutoScrollLocked/);
  assert.match(messageHandlerSource, /respectUserScroll/);
  assert.match(messageHandlerSource, /detailsScrollTop/);
  assert.match(messageHandlerSource, /const shouldStickToBottom = this\.isMessagesNearBottom\(\)/);
  assert.match(messageHandlerSource, /scrollMessagesToBottom\(\{ force: shouldStickToBottom, respectUserScroll: true \}\)/);
  assert.doesNotMatch(messageHandlerSource, /this\.elements\.messages\.scrollTop = this\.elements\.messages\.scrollHeight/);
  assert.match(messageHandlerSource, /renderManimResultContent/);
  assert.match(messageHandlerSource, /attachManimResultToProcess\(finalResult\)/);
  assert.match(messageHandlerSource, /manim-process-result manim-studio-result hidden/);
  assert.match(messageHandlerSource, /process\.messageDiv\.classList\.add\('has-result'\)/);
  assert.match(messageHandlerSource, /制作过程已完成/);
  assert.match(messageHandlerSource, /toggleManimProcessBubble\(!hasProblem\)/);
  assert.doesNotMatch(messageHandlerSource, /this\._handleManimResponse\(finalResult\)/);
  assert.doesNotMatch(messageHandlerSource, /updateManimAgentProgress\(\{ step: 'plan'/);

  assert.match(mainCssSource, /\.manim-process-card/);
  assert.match(mainCssSource, /@keyframes manim-card-breathe/);
  assert.match(mainCssSource, /@keyframes manim-dot-pulse/);
  assert.match(mainCssSource, /\.manim-process-card\[data-status="active"\]/);
  assert.match(mainCssSource, /\.manim-process-step\.active/);
  assert.match(mainCssSource, /\.manim-process-detail\.is-focus/);
  assert.match(mainCssSource, /prefers-reduced-motion: reduce/);
  assert.match(mainCssSource, /\.manim-result-heading/);
  assert.match(mainCssSource, /\.manim-studio-result \.video-container/);
  assert.match(mainCssSource, /\.manim-process-timeline/);
  assert.match(mainCssSource, /grid-template-columns: 172px minmax\(0, 1fr\)/);
  assert.match(mainCssSource, /--manim-process-pane-height: clamp\(300px, 42vh, 460px\)/);
  assert.match(mainCssSource, /\.manim-process-timeline[\s\S]*height: var\(--manim-process-pane-height\)/);
  assert.match(mainCssSource, /\.manim-process-details[\s\S]*height: var\(--manim-process-pane-height\)/);
  assert.match(mainCssSource, /\.manim-process-timeline[\s\S]*display: grid/);
  assert.match(mainCssSource, /\.manim-process-step-label/);
  assert.match(mainCssSource, /text-overflow: ellipsis/);
  assert.match(mainCssSource, /\.manim-process-details/);
  assert.match(mainCssSource, /max-height: clamp\(260px, 38vh, 420px\)/);
  assert.match(mainCssSource, /overflow-y: auto/);
  assert.match(mainCssSource, /overflow-x: hidden/);
  assert.match(mainCssSource, /overscroll-behavior: contain/);
  assert.match(mainCssSource, /-webkit-overflow-scrolling: touch/);
  assert.match(mainCssSource, /\.manim-process-detail\.pending/);
  assert.match(mainCssSource, /\.manim-clarification-panel/);
  assert.match(mainCssSource, /\.manim-clarification-question/);
  assert.match(mainCssSource, /\.manim-clarification-options/);
  assert.match(mainCssSource, /\.manim-clarification-option/);
  assert.match(mainCssSource, /\.manim-clarification-option\.is-selected/);
  assert.match(mainCssSource, /body:not\(\.light-mode\) \.manim-clarification-panel/);
  assert.match(mainCssSource, /body\.light-mode \.manim-clarification-option/);
  assert.match(mainCssSource, /width: min\(720px, 100%\)/);
  assert.match(mainCssSource, /\.manim-process-result/);
  assert.match(mainCssSource, /\.message\.bot\.manim-process-message-row\.has-result/);
  assert.match(mainCssSource, /\.manim-process-card\.collapsed/);
  assert.match(mainCssSource, /\.message\.bot\.manim-process-message-row/);
  assert.match(mainCssSource, /body\.light-mode \.message\.bot \.message-content\.manim-process-message/);
  assert.match(mainCssSource, /--manim-process-card-bg/);
  assert.match(mainCssSource, /--manim-process-result-bg/);
  assert.match(mainCssSource, /--manim-process-stage-active-bg/);
  assert.match(mainCssSource, /body\.light-mode[\s\S]*--manim-process-card-bg/);
  assert.match(mainCssSource, /body:not\(\.light-mode\) \.manim-process-status/);
  assert.match(mainCssSource, /body:not\(\.light-mode\) \.manim-process-current/);
  assert.match(mainCssSource, /background: var\(--manim-process-card-bg\)/);
  assert.match(mainCssSource, /background: var\(--manim-process-result-bg\)/);
  assert.match(mainCssSource, /background: var\(--manim-process-video-meta-bg\)/);
  assert.match(mainCssSource, /--manim-process-panel-border/);
  assert.match(mainCssSource, /\.manim-process-detail::before/);
  assert.match(mainCssSource, /body\.light-mode \.manim-process-card/);
  assert.match(mainCssSource, /body\.light-mode \.manim-process-current/);
  assert.match(mainCssSource, /box-shadow: none !important/);
  assert.match(mainCssSource, /\.manim-workbench-btn/);
  assert.match(mainCssSource, /\.manim-workbench-overlay/);
  assert.match(mainCssSource, /\.manim-workbench-panel/);
  assert.match(mainCssSource, /\.manim-workbench-panel\.is-positioned/);
  assert.match(mainCssSource, /\.manim-workbench-panel\.is-dragging/);
  assert.match(mainCssSource, /\.manim-workbench-drag-handle/);
  assert.match(mainCssSource, /cursor: grab/);
  assert.match(mainCssSource, /cursor: grabbing/);
  assert.match(mainCssSource, /body\.light-mode \.manim-workbench-panel/);
  assert.match(mainCssSource, /--manim-studio-surface/);
  assert.match(mainCssSource, /--manim-studio-border/);
  assert.match(mainCssSource, /--manim-studio-accent/);
  assert.match(mainCssSource, /\.manim-reference-dropzone/);
  assert.match(mainCssSource, /\.manim-reference-actions/);
  assert.match(mainCssSource, /\.manim-reference-sketch/);
  assert.match(mainCssSource, /\.manim-sketch-overlay/);
  assert.match(mainCssSource, /\.manim-sketch-shell/);
  assert.match(mainCssSource, /\.manim-sketch-canvas/);
  assert.match(mainCssSource, /\.manim-sketch-canvas\.tool-pen/);
  assert.match(mainCssSource, /\.manim-sketch-canvas\.tool-eraser/);
  assert.match(mainCssSource, /cursor: url\("data:image\/svg\+xml/);
  assert.match(mainCssSource, /touch-action: none/);
  assert.match(mainCssSource, /\.manim-config-summary/);
  assert.match(mainCssSource, /\.manim-workbench-debug/);
  assert.match(mainCssSource, /\.manim-style-option/);
  assert.match(mainCssSource, /\.manim-skill-chip/);
  assert.match(mainCssSource, /\.manim-reference-item/);
  assert.match(mainCssSource, /\.manim-current-job/);
  assert.match(mainCssSource, /\.manim-failure-row/);
  assert.match(mobileCssSource, /\.manim-process-details/);
  assert.match(mobileCssSource, /\.manim-clarification-options/);
  assert.match(mobileCssSource, /\.manim-clarification-option/);
  assert.match(mobileCssSource, /max-height: 34vh/);
  assert.match(mobileCssSource, /overflow-y: auto/);
  assert.match(mobileCssSource, /overflow-x: hidden/);
  assert.match(mobileCssSource, /\.manim-process-result/);
  assert.match(mobileCssSource, /\.manim-result-heading/);
  assert.match(mobileCssSource, /\.manim-process-timeline[\s\S]*height: auto/);
  assert.match(mobileCssSource, /\.manim-process-details[\s\S]*max-height: 34vh/);
  assert.match(mobileCssSource, /\.manim-workbench-panel/);
  assert.match(mobileCssSource, /\.manim-workbench-panel\.is-positioned/);
  assert.match(mobileCssSource, /position: relative !important/);
  assert.match(mobileCssSource, /\.manim-workbench-drag-handle/);
  assert.match(mobileCssSource, /touch-action: auto/);
  assert.match(mobileCssSource, /max-height: 80vh/);
  assert.match(mobileCssSource, /\.manim-workbench-body/);
  assert.match(mobileCssSource, /\.manim-config-summary/);
  assert.match(mobileCssSource, /\.manim-sketch-overlay/);
  assert.match(mobileCssSource, /\.manim-sketch-shell/);
  assert.match(mobileCssSource, /\.manim-sketch-canvas-wrap/);
});

test('Manim Studio code panel uses the redesigned workspace shell', async () => {
  const [indexSource, codePanelSource, mainCssSource, mobileCssSource, studioCanvasSource, studioBundleSource] = await Promise.all([
    readFile(indexPath, 'utf8'),
    readFile(codePanelPath, 'utf8'),
    readFile(mainCssPath, 'utf8'),
    readFile(mobileCssPath, 'utf8'),
    readFile(studioCanvasPath, 'utf8'),
    readFile(studioBundlePath, 'utf8'),
  ]);

  assert.match(indexSource, /class="code-panel manim-studio-window"/);
  assert.match(indexSource, /studio-title-sub">动画代码与预览工作区/);
  assert.match(indexSource, /studio-preview-workspace/);
  assert.match(indexSource, /studio-preview-stack/);
  assert.match(indexSource, /studio-reference-video-shell/);
  assert.match(indexSource, /id="studio-frame-strip"/);
  assert.match(indexSource, /id="studio-calibration-frame-wrap"/);
  assert.match(indexSource, /静态校准画布/);
  assert.match(indexSource, /id="studio-interaction-overlay"/);
  assert.match(indexSource, /id="studio-object-inspector"/);
  assert.match(indexSource, /id="manim-history-root" class="history-list-container studio-history-panel"/);
  assert.match(indexSource, /studio-editor-panel/);
  assert.match(indexSource, /studio-command-bar/);
  assert.match(indexSource, /试试：把标题字体调大至 40/);
  assert.match(indexSource, /js\/studio\/manim-studio-canvas\.js/);

  assert.match(codePanelSource, /ManimStudioCanvas/);
  assert.match(codePanelSource, /studio-konva-root/);
  assert.match(codePanelSource, /has-react-studio-canvas/);
  assert.match(codePanelSource, /studioRevision/);
  assert.match(codePanelSource, /syncReactStudioCanvas/);
  assert.match(codePanelSource, /normalizeStudioFrameSetForRevision/);
  assert.match(codePanelSource, /withStudioCacheBust/);
  assert.match(codePanelSource, /stripStudioCacheParam/);
  assert.match(codePanelSource, /handleReactStudioApply/);
  assert.match(codePanelSource, /convertReactStudioCanvasState/);
  assert.match(codePanelSource, /studio-preview-video/);
  assert.match(codePanelSource, /registerSceneManifest/);
  assert.match(codePanelSource, /renderSceneOverlay/);
  assert.match(codePanelSource, /runtimeSceneManifest/);
  assert.match(codePanelSource, /getSceneObjectBoxForCurrentTime/);
  assert.match(codePanelSource, /buildInteractiveHitTargets/);
  assert.doesNotMatch(codePanelSource, /matchRegionsToSceneObjects\(objects, regions\)/);
  assert.match(codePanelSource, /localizeSceneObjectType/);
  assert.match(codePanelSource, /getSceneObjectDisplayLabel/);
  assert.match(codePanelSource, /selectSceneObject/);
  assert.match(codePanelSource, /selectedSceneObjects/);
  assert.match(codePanelSource, /selectSceneObjects/);
  assert.match(codePanelSource, /selectSceneObjectsInBox/);
  assert.match(codePanelSource, /buildCollisionGroups/);
  assert.match(codePanelSource, /applyScenePatch/);
  assert.match(codePanelSource, /studioFrameSet/);
  assert.match(codePanelSource, /recommendedFrameId/);
  assert.match(codePanelSource, /referenceVideo/);
  assert.match(codePanelSource, /studio-video-reference-container/);
  assert.match(codePanelSource, /renderStudioFrameStrip/);
  assert.match(codePanelSource, /selectStudioFrame/);
  assert.match(codePanelSource, /createManualStudioObject/);
  assert.match(codePanelSource, /startStudioObjectDrag/);
  assert.match(codePanelSource, /layout_calibrate/);
  assert.match(codePanelSource, /buildLayoutEditSpec/);
  assert.match(codePanelSource, /\/api\/manim\/layout-rebuild/);
  assert.doesNotMatch(codePanelSource, /studio-object-palette/);
  assert.doesNotMatch(codePanelSource, /<span>\$\{this\.escapeHtml\(item\.type \|\| '对象'\)\}<\/span>/);
  assert.doesNotMatch(codePanelSource, /window\.prompt/);
  assert.match(codePanelSource, /studio-object-hotspot/);
  assert.match(codePanelSource, /studio-object-cluster/);
  assert.match(codePanelSource, /studio-object-picker/);
  assert.match(codePanelSource, /closeSceneObjectPicker/);
  assert.match(codePanelSource, /renderSceneObjectHoverPreview/);
  assert.match(codePanelSource, /getSceneObjectPreviewStyle/);
  assert.match(codePanelSource, /showSceneObjectHoverPreview/);
  assert.match(codePanelSource, /hideSceneObjectHoverPreview/);
  assert.match(codePanelSource, /positionSceneObjectHoverPreview/);
  assert.match(codePanelSource, /getSceneObjectPickerPosition/);
  assert.match(codePanelSource, /topSafeArea/);
  assert.match(codePanelSource, /studio-object-hover-preview/);
  assert.match(codePanelSource, /data-picker-close/);
  assert.match(codePanelSource, /data-picker-preview-id/);
  assert.match(codePanelSource, /touchAction: 'toggle-preview'/);
  assert.match(codePanelSource, /单独选择/);
  assert.match(codePanelSource, /暂无预览/);
  assert.match(codePanelSource, /studio-live-object/);
  assert.match(codePanelSource, /可拖动对象/);
  assert.match(codePanelSource, /getSceneObjectPriority/);
  assert.match(codePanelSource, /prioritizeSceneObjects/);
  assert.match(codePanelSource, /studio-object-command-input/);
  assert.match(codePanelSource, /data-studio-suggestion/);
  assert.match(codePanelSource, /applyNaturalLanguageEdit/);
  assert.match(codePanelSource, /naturalLanguageEdit/);
  assert.match(codePanelSource, /selectedObjectSnapshot/);
  assert.match(codePanelSource, /selectedObjectIds/);
  assert.match(codePanelSource, /selectedObjectSnapshots/);
  assert.match(codePanelSource, /selectionBBox/);
  assert.match(codePanelSource, /selectionMode/);
  assert.match(codePanelSource, /groupEdit/);
  assert.match(codePanelSource, /studio-selected-chip/);
  assert.match(codePanelSource, /应用到整段动画/);
  assert.match(codePanelSource, /history-list-container studio-history-panel/);
  assert.match(codePanelSource, /<i data-lucide="play"><\/i> 运行/);
  assert.doesNotMatch(codePanelSource, /style="width:100%; height:100%; object-fit:contain;"/);
  assert.match(codePanelSource, /manualReferenceRegions/);
  assert.match(codePanelSource, /objectEdits/);
  assert.match(codePanelSource, /objectEdits,\s*\n\s*edits: objectEdits/);
  assert.doesNotMatch(codePanelSource, /patch\.operation === 'natural_language_edit'\s*\?\s*pendingEdits\s*:\s*objectEdits/);
  assert.match(codePanelSource, /createCanvasEditState/);
  assert.match(codePanelSource, /canvasEditState/);
  assert.match(codePanelSource, /studio-canvas-tooling/);
  assert.match(codePanelSource, /button\('select', '选择'\)/);
  assert.match(codePanelSource, /button\('manual', '手动画框'\)/);
  assert.match(codePanelSource, /data-studio-add-object="text"/);
  assert.match(codePanelSource, /data-studio-add-object="formula"/);
  assert.match(codePanelSource, /data-studio-add-object="arrow"/);
  assert.match(codePanelSource, /data-studio-delete-selected/);
  assert.match(codePanelSource, /data-studio-apply-layout/);
  assert.match(codePanelSource, /pendingObjectEdits/);
  assert.match(codePanelSource, /pendingNewObjects/);
  assert.match(codePanelSource, /pendingDeletes/);
  assert.match(codePanelSource, /objectBoxOverrides/);
  assert.match(codePanelSource, /getEditedSceneObjectBox/);
  assert.match(codePanelSource, /renderStudioObjectLayer/);
  assert.match(codePanelSource, /displayMode: 'clean'/);
  assert.match(codePanelSource, /isStudioDebugMode/);
  assert.match(codePanelSource, /icecream_manim_debug/);
  assert.match(codePanelSource, /normalizeCanvasTool/);
  assert.match(codePanelSource, /box-select/);
  assert.match(codePanelSource, /shouldRenderStudioLiveObject/);
  assert.match(codePanelSource, /getRenderableStudioObjects/);
  assert.match(codePanelSource, /clusterMemberIds/);
  assert.match(codePanelSource, /is-debug-visible/);
  assert.match(codePanelSource, /is-quiet/);
  assert.match(codePanelSource, /studioWheelCloseBound/);
  assert.match(codePanelSource, /studio-live-object/);
  assert.match(codePanelSource, /startStudioLiveObjectDrag/);
  assert.match(codePanelSource, /syncStudioLiveObjectsToDom/);
  assert.match(codePanelSource, /getStudioProxyKind/);
  assert.match(codePanelSource, /对象化交互编辑层/);
  assert.match(codePanelSource, /newObjects/);
  assert.match(codePanelSource, /deletedObjectIds/);
  assert.match(codePanelSource, /applyStudioRenderResult/);
  assert.match(codePanelSource, /this\.studioFrameSetMap\.delete\(this\.currentVideoId\)/);
  assert.match(codePanelSource, /requestAnimationFrame\(\(\) => this\.syncReactStudioCanvas\(\)\)/);
  assert.match(codePanelSource, /handleStudioFrameImageError/);
  assert.match(codePanelSource, /_imageLoadFailed/);
  assert.match(codePanelSource, /已切换到可用关键帧/);
  assert.match(codePanelSource, /Number\(right\.objectCount \|\| 0\) - Number\(left\.objectCount \|\| 0\)/);
  assert.match(codePanelSource, /clearInvalidStudioFrameSelection/);
  assert.doesNotMatch(codePanelSource, /当前版本请优先选择已有对象进行整段重构/);
  assert.doesNotMatch(codePanelSource, /background-color: #ef4444 !important/);

  assert.match(studioCanvasSource, /react-konva/);
  assert.match(studioCanvasSource, /zustand/);
  assert.match(studioCanvasSource, /Stage/);
  assert.match(studioCanvasSource, /Layer/);
  assert.match(studioCanvasSource, /KonvaImage/);
  assert.match(studioCanvasSource, /studioRevision = 0/);
  assert.match(studioCanvasSource, /videoUrl = ''/);
  assert.match(studioCanvasSource, /useCanvasStore\.getState\(\)\.resetDraft\(\)/);
  assert.match(studioCanvasSource, /setImage\(null\);\s*setFailed\(false\);/s);
  assert.match(studioCanvasSource, /objectBoxOverrides/);
  assert.match(studioCanvasSource, /objectEdits/);
  assert.match(studioCanvasSource, /newObjects/);
  assert.match(studioCanvasSource, /updateNewObjectText/);
  assert.match(studioCanvasSource, /commitInlineEditor/);
  assert.match(studioCanvasSource, /studio-inline-object-editor/);
  assert.match(studioCanvasSource, /formulaNoChinese/);
  assert.match(studioCanvasSource, /objectInputRequired/);
  assert.match(studioCanvasSource, /输入文字内容/);
  assert.match(studioCanvasSource, /例如：x\^2\+y\^2=r\^2/);
  assert.match(studioCanvasSource, /deletedObjectIds/);
  assert.match(studioCanvasSource, /manualReferenceRegions/);
  assert.match(studioCanvasSource, /naturalLanguageEdit/);
  assert.match(studioCanvasSource, /box-select/);
  assert.match(studioCanvasSource, /add_text/);
  assert.match(studioCanvasSource, /add_formula/);
  assert.match(studioCanvasSource, /add_arrow/);
  assert.match(studioCanvasSource, /onApply/);
  assert.match(studioCanvasSource, /window\.ManimStudioCanvas/);
  assert.match(studioBundleSource, /ManimStudioCanvas/);

  assert.match(mainCssSource, /#code-panel\.manim-studio-window/);
  assert.match(mainCssSource, /--studio-bg: var\(--manim-studio-surface\)/);
  assert.match(mainCssSource, /--studio-surface: var\(--manim-studio-surface\)/);
  assert.match(mainCssSource, /grid-template-columns: minmax\(520px, 42%\) minmax\(0, 1fr\)/);
  assert.match(mainCssSource, /aspect-ratio: 16 \/ 9/);
  assert.match(mainCssSource, /#code-panel\.manim-studio-window #manim-history-root/);
  assert.match(mainCssSource, /max-height: clamp\(92px, 17vh, 180px\)/);
  assert.match(mainCssSource, /#code-panel\.manim-studio-window #manim-history-root:not\(\.expanded\)/);
  assert.match(mainCssSource, /#code-panel\.manim-studio-window #manim-history-root:not\(\.expanded\) \.history-list/);
  assert.match(mainCssSource, /display: none !important/);
  assert.match(mainCssSource, /\.studio-preview-video/);
  assert.match(mainCssSource, /\.studio-interaction-overlay/);
  assert.match(mainCssSource, /\.studio-preview-stack/);
  assert.match(mainCssSource, /\.studio-reference-video-shell/);
  assert.match(mainCssSource, /\.studio-frame-strip/);
  assert.match(mainCssSource, /\.studio-calibration-frame/);
  assert.match(mainCssSource, /\.studio-frame-meta/);
  assert.match(mainCssSource, /\.studio-frame-label/);
  assert.match(mainCssSource, /\.studio-calibration-empty-state/);
  assert.match(mainCssSource, /#video-inner-container\.studio-video-stage/);
  assert.match(mainCssSource, /min-height: 320px/);
  assert.match(mainCssSource, /\.studio-manual-selection/);
  assert.match(mainCssSource, /\.studio-canvas-tooling/);
  assert.match(mainCssSource, /\.studio-canvas-tooling button\.primary/);
  assert.match(mainCssSource, /\.studio-interaction-overlay\.is-manual-drawing/);
  assert.match(mainCssSource, /\.studio-object-layer/);
  assert.match(mainCssSource, /\.studio-live-object/);
  assert.match(mainCssSource, /\.studio-live-object\.is-quiet/);
  assert.match(mainCssSource, /\.studio-live-object\.is-debug-visible/);
  assert.match(mainCssSource, /background: transparent/);
  assert.match(mainCssSource, /opacity: 0\.16/);
  assert.match(mainCssSource, /\.studio-live-object\.is-text/);
  assert.match(mainCssSource, /\.studio-live-crop/);
  assert.match(mainCssSource, /\.studio-live-text/);
  assert.match(mainCssSource, /\.studio-interaction-overlay\.is-object-dragging/);
  assert.match(mainCssSource, /touch-action: none/);
  assert.match(mainCssSource, /\.studio-object-hotspot/);
  assert.match(mainCssSource, /\.studio-object-cluster/);
  assert.match(mainCssSource, /\.studio-object-picker/);
  assert.match(mainCssSource, /\.studio-object-picker-list/);
  assert.match(mainCssSource, /--studio-font-body: var\(--font-heading/);
  assert.match(mainCssSource, /\.studio-object-hover-preview/);
  assert.match(mainCssSource, /\.studio-object-hover-preview-image/);
  assert.match(mainCssSource, /\.studio-object-hover-preview-meta/);
  assert.match(mainCssSource, /\.studio-object-picker-close/);
  assert.match(mainCssSource, /\.studio-object-picker-status/);
  assert.match(mainCssSource, /\.studio-object-picker-add/);
  assert.match(mainCssSource, /font-family: var\(--studio-font-body\)/);
  assert.match(mainCssSource, /\.studio-selection-marquee/);
  assert.match(mainCssSource, /\.studio-selected-chip-list/);
  assert.match(mainCssSource, /\.studio-object-rect/);
  assert.match(mainCssSource, /\.studio-object-label/);
  assert.doesNotMatch(mainCssSource, /\.studio-object-palette/);
  assert.match(mainCssSource, /\.studio-object-inspector/);
  assert.match(mainCssSource, /\.studio-object-natural-editor/);
  assert.match(mainCssSource, /\.studio-object-command-input/);
  assert.match(mainCssSource, /\.studio-object-suggestion/);
  assert.match(mainCssSource, /\.studio-object-apply/);
  assert.match(mainCssSource, /\.studio-konva-root/);
  assert.match(mainCssSource, /\.manim-studio-canvas-app/);
  assert.match(mainCssSource, /\.studio-konva-toolbar/);
  assert.match(mainCssSource, /\.studio-konva-stage-shell/);
  assert.match(mainCssSource, /\.studio-inline-object-editor/);
  assert.match(mainCssSource, /\.studio-konva-inspector/);
  assert.match(mainCssSource, /\.has-react-studio-canvas/);
  assert.match(mainCssSource, /\.desktop-footer/);

  assert.match(mobileCssSource, /Manim Studio Mobile Redesign/);
  assert.match(mobileCssSource, /height: min\(90vh, 820px\)/);
  assert.match(mobileCssSource, /#code-panel\.manim-studio-window \.mobile-panel-tabs/);
  assert.match(mobileCssSource, /max-height: 24vh/);
  assert.match(mobileCssSource, /\.studio-reference-video-shell/);
  assert.match(mobileCssSource, /\.studio-canvas-tooling/);
  assert.match(mobileCssSource, /\.studio-object-layer/);
  assert.match(mobileCssSource, /\.studio-live-object/);
  assert.match(mobileCssSource, /\.studio-live-object\.is-quiet/);
  assert.match(mobileCssSource, /\.studio-live-text/);
  assert.match(mobileCssSource, /\.studio-calibration-card/);
  assert.match(mobileCssSource, /\.studio-frame-meta/);
  assert.match(mobileCssSource, /min-height: 210px/);
  assert.match(mobileCssSource, /#code-panel\.manim-studio-window #manim-history-root:not\(\.expanded\) \.history-list/);
  assert.match(mobileCssSource, /\.studio-object-inspector/);
  assert.match(mobileCssSource, /\.studio-object-hotspot/);
  assert.match(mobileCssSource, /\.studio-object-cluster/);
  assert.match(mobileCssSource, /\.studio-object-picker/);
  assert.match(mobileCssSource, /\.studio-object-hover-preview/);
  assert.match(mobileCssSource, /\.studio-object-hover-preview-image/);
  assert.match(mobileCssSource, /\.studio-object-command-input/);
  assert.match(mobileCssSource, /\.studio-object-apply/);
  assert.match(mobileCssSource, /\.studio-konva-root/);
  assert.match(mobileCssSource, /\.studio-konva-stage-shell/);
  assert.match(mobileCssSource, /\.studio-inline-object-editor/);
  assert.match(mobileCssSource, /\.studio-konva-inspector/);
  assert.match(mobileCssSource, /overscroll-behavior: contain/);
});

test('frontend task switcher uses three visible tasks and guards cross-task routing', async () => {
  const [indexSource, constantsSource, modeSwitcherSource, messageHandlerSource, intentConfirmSource, manimWorkbenchSource, appSource, mainCssSource, mobileCssSource] = await Promise.all([
    readFile(indexPath, 'utf8'),
    readFile(new URL('../public/js/constants.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/js/core/mode-switcher.js', import.meta.url), 'utf8'),
    readFile(messageHandlerPath, 'utf8'),
    readFile(intentConfirmPath, 'utf8'),
    readFile(manimWorkbenchPath, 'utf8'),
    readFile(appPath, 'utf8'),
    readFile(mainCssPath, 'utf8'),
    readFile(mobileCssPath, 'utf8'),
  ]);

  const switcherMarkup = indexSource.match(/<div class="mode-switcher"[\s\S]*?<\/div>/)?.[0] || '';
  assert.match(switcherMarkup, /data-mode="auto"[\s\S]*问答/);
  assert.match(switcherMarkup, /data-mode="manim"[\s\S]*动画/);
  assert.match(switcherMarkup, /data-mode="solver"[\s\S]*解题/);
  assert.doesNotMatch(switcherMarkup, /data-mode="chat"/);
  assert.match(indexSource, /data-mode="auto"[\s\S]*智能问答/);
  assert.match(constantsSource, /问答模式 · 智能识别任务/);
  assert.match(constantsSource, /问点什么，或描述动画\/上传题目/);

  assert.match(modeSwitcherSource, /const displayMode = mode === 'chat' \? 'auto' : mode/);
  assert.match(modeSwitcherSource, /tab\.dataset\.mode === displayMode/);

  assert.match(messageHandlerSource, /getCrossTaskTarget/);
  assert.match(messageHandlerSource, /looksLikeSolverRequest/);
  assert.match(messageHandlerSource, /looksLikeManimRequest/);
  assert.match(messageHandlerSource, /showTaskSwitchPrompt/);
  assert.match(messageHandlerSource, /看起来这是\$\{targetLabel\}请求，要切到\$\{targetLabel\}吗/);
  assert.match(messageHandlerSource, /切到\$\{targetLabel\}/);
  assert.match(messageHandlerSource, /仍按\$\{currentLabel\}处理/);
  assert.doesNotMatch(messageHandlerSource, /作为动画参考图/);
  assert.doesNotMatch(messageHandlerSource, /作为解题图片/);
  assert.doesNotMatch(messageHandlerSource, /imagePurpose === 'reference'/);
  assert.doesNotMatch(messageHandlerSource, /uploadReferenceDataUrl/);
  assert.match(messageHandlerSource, /return 'solver';/);
  assert.match(messageHandlerSource, /modeSwitcher\.setMode\(pending\.targetMode, true\)/);
  assert.match(messageHandlerSource, /skipRouteGuard: true/);
  assert.match(messageHandlerSource, /messageOverride: pending\.message \|\| ''/);
  assert.match(messageHandlerSource, /const messageOverride = typeof options\.messageOverride === 'string'/);
  assert.match(messageHandlerSource, /response\.originalMessage = message/);
  assert.match(messageHandlerSource, /currentMode === 'manim' && hasImage/);
  assert.match(appSource, /data\.originalMessage \|\| data\.message \|\| data\.prompt/);
  assert.match(messageHandlerSource, /getLastSubmittedMessage\(\)/);
  assert.match(messageHandlerSource, /this\.lastSubmittedMessage = message/);
  assert.match(messageHandlerSource, /this\.lastSubmittedMessage = ''/);
  assert.match(appSource, /原始消息丢失，请重新输入/);
  assert.match(appSource, /if \(!response\.ok\)/);
  assert.match(intentConfirmSource, /this\.isSubmitting/);
  assert.match(intentConfirmSource, /async confirm\(intent\)/);
  assert.match(intentConfirmSource, /await this\.onConfirm\(intent, data\)/);

  assert.match(manimWorkbenchSource, /querySelector\('\.mode-tab\[data-mode="manim"\]'\)/);
  assert.match(manimWorkbenchSource, /insertAdjacentElement\('afterend', this\.button\)/);
  assert.match(manimWorkbenchSource, /manim-workbench-tab/);
  assert.match(manimWorkbenchSource, /uploadReferenceDataUrl/);
  assert.match(manimWorkbenchSource, /参考图已加入动画工作台/);
  assert.match(appSource, /messageHandler\.clearTaskPrompts\?\.\(\)/);

  assert.match(mainCssSource, /\.task-switch-prompt/);
  assert.match(mainCssSource, /\.task-switch-btn\.primary/);
  assert.match(mainCssSource, /\.intent-confirm\.is-pending \.intent-option/);
  assert.match(mainCssSource, /contain: layout paint/);
  assert.match(mainCssSource, /\.manim-workbench-tab/);
  assert.match(mainCssSource, /body\.light-mode \.task-switch-prompt/);
  assert.match(mobileCssSource, /\.task-switch-prompt/);
  assert.match(mobileCssSource, /\.task-switch-actions/);
  assert.match(mobileCssSource, /\.manim-workbench-tab/);
});

test('Manim frontend and gateway user-facing files do not contain mojibake literals', async () => {
  const sources = await Promise.all([
    readFile(indexPath, 'utf8'),
    readFile(codePanelPath, 'utf8'),
    readFile(messageHandlerPath, 'utf8'),
    readFile(manimWorkbenchPath, 'utf8'),
    readFile(manimSketchPadPath, 'utf8'),
    readFile(new URL('../services/manim/manim-client.js', import.meta.url), 'utf8'),
  ]);
  const forbidden = ['\u9422', '\u6d93', '\u9366', '\u8930', '\ufffd'];

  for (const source of sources) {
    for (const marker of forbidden) {
      assert.equal(source.includes(marker), false, `user-facing Manim source contains mojibake marker ${marker}`);
    }
  }
});

test('Manim agent unavailable returns a compatible non-rendered warning', async () => {
  await withGatewayAndManim((req, res) => {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'agent-down' }));
  }, async appBase => {
    const response = await fetch(`${appBase}/api/manim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '画个动画' }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.intent, 'manim');
    assert.equal(payload.rendered, false);
    assert.match(payload.warning, /agent-down|Agent/);
  });
});

test('frontend routes main chat and code panel Manim work through the streaming agent', async () => {
  const [messageHandlerSource, codePanelSource, mainCssSource, mobileCssSource] = await Promise.all([
    readFile(messageHandlerPath, 'utf8'),
    readFile(codePanelPath, 'utf8'),
    readFile(mainCssPath, 'utf8'),
    readFile(mobileCssPath, 'utf8'),
  ]);

  assert.match(messageHandlerSource, /\/api\/manim\/intent/);
  assert.match(messageHandlerSource, /sendManimAgentStream/);
  assert.match(messageHandlerSource, /\/api\/manim\/agent\/stream/);
  assert.match(messageHandlerSource, /event\.type === 'clarification'/);
  assert.match(messageHandlerSource, /!event\.recoverable/);

  assert.match(codePanelSource, /\/api\/manim\/agent\/stream/);
  assert.match(codePanelSource, /mode:\s*'modify'/);
  assert.match(codePanelSource, /currentCode/);
  assert.match(codePanelSource, /!event\.recoverable/);
  assert.match(codePanelSource, /patch_plan/);
  assert.match(codePanelSource, /renderStudioPatchReport/);
  assert.match(codePanelSource, /studio-report-revert/);
  assert.match(codePanelSource, /studio-report-visible/);

  assert.match(mainCssSource, /\.code-panel-studio-report/);
  assert.match(mainCssSource, /#code-panel\.studio-report-visible #monaco-container/);
  assert.match(mainCssSource, /\.studio-report-status\.success/);
  assert.match(mainCssSource, /\.studio-report-status\.warning/);
  assert.match(mainCssSource, /\.studio-report-status\.error/);
  assert.match(mainCssSource, /body\.light-mode \.code-panel-studio-report/);
  assert.match(mobileCssSource, /\.code-panel \.mobile-code-tab \.code-panel-studio-report/);
  assert.match(mobileCssSource, /#code-panel\.studio-report-visible \.mobile-code-tab #monaco-container/);
});
