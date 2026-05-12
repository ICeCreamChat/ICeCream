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
  }), {
    message: '画一个流程图',
    mode: 'create',
    currentCode: '',
    clientId: 'classroom_1',
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
  });
});

test('Manim agent stream timeout and abort errors are user-facing Chinese', () => {
  assert.equal(getManimAgentStreamTimeoutMs({}), 360000);
  assert.equal(getManimAgentStreamTimeoutMs({ MANIM_AGENT_STREAM_TIMEOUT_MS: '120000' }), 300000);
  assert.equal(getManimAgentStreamTimeoutMs({ MANIM_AGENT_STREAM_TIMEOUT_MS: '420' }), 420000);

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
        agentTrace: { codeSource: 'llm_v4', template: 'none', skills: ['flow_explanation'], retries: 0 },
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
    assert.equal(payload.agentTrace.codeSource, 'llm_v4');
    assert.equal(payload.agentTrace.template, 'none');
  });
});

test('POST /api/manim/agent/stream proxies v4 NDJSON agent events', async () => {
  let observedRequest;

  await withGatewayAndManim((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      observedRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.write(JSON.stringify({ type: 'progress', step: 'planner', message: 'planning' }) + '\n');
      res.write(JSON.stringify({ type: 'design', design: { status: 'success' } }) + '\n');
      res.write(JSON.stringify({ type: 'storyboard', storyboard: [{ title: 'step' }] }) + '\n');
      res.write(JSON.stringify({ type: 'style', style: { name: 'teaching_premium' } }) + '\n');
      res.write(JSON.stringify({ type: 'visual_check', visual: { status: 'pass' } }) + '\n');
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
    assert.match(text, /"type":"design"/);
    assert.match(text, /"type":"storyboard"/);
    assert.match(text, /"type":"style"/);
    assert.match(text, /"type":"visual_check"/);
    assert.match(text, /"type":"result"/);
  });
});

test('frontend shows Manim agent v4 production progress in a chat bubble', async () => {
  const [messageHandlerSource, mainCssSource, mobileCssSource] = await Promise.all([
    readFile(messageHandlerPath, 'utf8'),
    readFile(mainCssPath, 'utf8'),
    readFile(mobileCssPath, 'utf8'),
  ]);

  assert.match(messageHandlerSource, /event\.type === 'plan'/);
  assert.match(messageHandlerSource, /event\.type === 'design'/);
  assert.match(messageHandlerSource, /event\.type === 'storyboard'/);
  assert.match(messageHandlerSource, /event\.type === 'style'/);
  assert.match(messageHandlerSource, /event\.type === 'skills'/);
  assert.match(messageHandlerSource, /event\.type === 'inspect'/);
  assert.match(messageHandlerSource, /event\.type === 'preview'/);
  assert.match(messageHandlerSource, /event\.type === 'visual_check'/);
  assert.match(messageHandlerSource, /event\.type === 'repair'/);
  assert.match(messageHandlerSource, /event\.type === 'quality_report'/);
  assert.match(messageHandlerSource, /createManimProcessBubble/);
  assert.match(messageHandlerSource, /updateManimProcessFromEvent/);
  assert.match(messageHandlerSource, /formatManimQualityDetails/);
  assert.match(messageHandlerSource, /formatManimVisualDetails/);
  assert.match(messageHandlerSource, /localizeManimText/);
  assert.match(messageHandlerSource, /localizeManimSkill/);
  assert.match(messageHandlerSource, /localizeManimError/);
  assert.match(messageHandlerSource, /函数图像教学/);
  assert.match(messageHandlerSource, /质量检查通过/);
  assert.match(messageHandlerSource, /正在修复视觉质量问题/);
  assert.match(messageHandlerSource, /生成时间过长，连接已中断/);
  assert.match(messageHandlerSource, /const hasProblem = event\.success === false \|\| !event\.rendered \|\| Boolean\(event\.warning\)/);
  assert.match(messageHandlerSource, /setManimProcessStep\('repair', event\.warning \? 'warning' : 'active'/);
  assert.match(messageHandlerSource, /localizeManimText\(report\.summary\)/);
  assert.doesNotMatch(messageHandlerSource, /\$\{name\}：\$\{skill\.guidance\}/);
  assert.doesNotMatch(messageHandlerSource, /details\.push\(report\.summary\)/);
  assert.match(messageHandlerSource, /setManimBottomLoadingVisible\(false\)/);
  assert.match(messageHandlerSource, /manim-process-card/);
  assert.match(messageHandlerSource, /制作过程已完成/);
  assert.match(messageHandlerSource, /toggleManimProcessBubble\(!hasProblem\)/);
  assert.doesNotMatch(messageHandlerSource, /updateManimAgentProgress\(\{ step: 'plan'/);

  assert.match(mainCssSource, /\.manim-process-card/);
  assert.match(mainCssSource, /\.manim-process-timeline/);
  assert.match(mainCssSource, /\.manim-process-details/);
  assert.match(mainCssSource, /\.manim-process-card\.collapsed/);
  assert.match(mainCssSource, /\.message\.bot\.manim-process-message-row/);
  assert.match(mainCssSource, /body\.light-mode \.message\.bot \.message-content\.manim-process-message/);
  assert.match(mainCssSource, /box-shadow: none !important/);
  assert.match(mobileCssSource, /\.manim-process-details/);
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
  const [messageHandlerSource, codePanelSource] = await Promise.all([
    readFile(messageHandlerPath, 'utf8'),
    readFile(codePanelPath, 'utf8'),
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
});
