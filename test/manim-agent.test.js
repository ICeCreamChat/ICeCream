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
const manimWorkbenchPath = new URL('../public/js/core/manim-workbench.js', import.meta.url);
const appPath = new URL('../public/js/app.js', import.meta.url);
const mainCssPath = new URL('../public/css/main.css', import.meta.url);
const mobileCssPath = new URL('../public/css/mobile.css', import.meta.url);

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
      res.write(JSON.stringify({ type: 'reference', references: [{ referenceId: 'ref-1', filename: 'sketch.png' }] }) + '\n');
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

    assert.equal(skills.skills[0].id, 'geometry');
    assert.equal(jobs.jobs[0].jobId, 'job-1');
    assert.equal(job.job.status, 'running');
    assert.equal(cancel.job.status, 'cancelled');
    assert.equal(failures.failures[0].eventId, 'fail-1');
    assert.equal(replay.replay.status, 'pass');
    assert.equal(reference.reference.referenceId, 'ref-1');
  });

  assert.deepEqual(observed.map(item => `${item.method} ${item.url}`), [
    'GET /agent/skills',
    'GET /agent/jobs?limit=2',
    'GET /agent/jobs/job-1',
    'POST /agent/jobs/job-1/cancel',
    'GET /agent/failures?limit=3',
    'POST /agent/failures/fail-1/replay',
    'POST /agent/reference-images',
  ]);
  assert.equal(observed.at(-1).body.filename, 'sketch.png');
});

test('frontend shows Manim agent v6 production progress in a chat bubble', async () => {
  const [messageHandlerSource, manimWorkbenchSource, appSource, mainCssSource, mobileCssSource] = await Promise.all([
    readFile(messageHandlerPath, 'utf8'),
    readFile(manimWorkbenchPath, 'utf8'),
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
  assert.match(manimWorkbenchSource, /replayFailure/);
  assert.match(manimWorkbenchSource, /setMode\(mode\)/);
  assert.match(manimWorkbenchSource, /动画工作台/);
  assert.match(manimWorkbenchSource, /生成设置/);
  assert.match(manimWorkbenchSource, /参考素材/);
  assert.match(manimWorkbenchSource, /任务状态/);
  assert.match(manimWorkbenchSource, /高级诊断/);

  assert.match(messageHandlerSource, /event\.type === 'plan'/);
  assert.match(messageHandlerSource, /event\.type === 'job'/);
  assert.match(messageHandlerSource, /event\.type === 'reference'/);
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
  assert.match(mainCssSource, /flex-wrap: wrap/);
  assert.match(mainCssSource, /\.manim-process-step-label/);
  assert.match(mainCssSource, /text-overflow: clip/);
  assert.match(mainCssSource, /\.manim-process-details/);
  assert.match(mainCssSource, /max-height: clamp\(260px, 38vh, 420px\)/);
  assert.match(mainCssSource, /overflow-y: auto/);
  assert.match(mainCssSource, /overflow-x: hidden/);
  assert.match(mainCssSource, /overscroll-behavior: contain/);
  assert.match(mainCssSource, /-webkit-overflow-scrolling: touch/);
  assert.match(mainCssSource, /\.manim-process-detail\.pending/);
  assert.match(mainCssSource, /width: min\(640px, 100%\)/);
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
  assert.match(mainCssSource, /body\.light-mode \.manim-workbench-panel/);
  assert.match(mainCssSource, /\.manim-style-option/);
  assert.match(mainCssSource, /\.manim-skill-chip/);
  assert.match(mainCssSource, /\.manim-reference-item/);
  assert.match(mainCssSource, /\.manim-current-job/);
  assert.match(mainCssSource, /\.manim-failure-row/);
  assert.match(mobileCssSource, /\.manim-process-details/);
  assert.match(mobileCssSource, /max-height: 34vh/);
  assert.match(mobileCssSource, /overflow-y: auto/);
  assert.match(mobileCssSource, /overflow-x: hidden/);
  assert.match(mobileCssSource, /\.manim-process-result/);
  assert.match(mobileCssSource, /\.manim-result-heading/);
  assert.match(mobileCssSource, /\.manim-workbench-panel/);
  assert.match(mobileCssSource, /max-height: 80vh/);
  assert.match(mobileCssSource, /\.manim-workbench-body/);
});

test('Manim frontend and gateway user-facing files do not contain mojibake literals', async () => {
  const sources = await Promise.all([
    readFile(messageHandlerPath, 'utf8'),
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
