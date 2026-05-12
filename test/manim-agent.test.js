import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';
import {
  buildAgentPayload,
  isManimAgentEnabled,
} from '../services/manim/manim-client.js';

const codePanelPath = new URL('../public/js/core/code-panel.js', import.meta.url);
const messageHandlerPath = new URL('../public/js/core/message-handler.js', import.meta.url);

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
        agentTrace: { skills: ['flow_explanation'], retries: 0 },
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
    assert.equal(payload.agentTrace.skills[0], 'flow_explanation');
  });
});

test('POST /api/manim/agent/stream proxies NDJSON agent events', async () => {
  let observedRequest;

  await withGatewayAndManim((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      observedRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.write(JSON.stringify({ type: 'progress', step: 'planner', message: 'planning' }) + '\n');
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
    assert.match(text, /"type":"result"/);
  });
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

  assert.match(codePanelSource, /\/api\/manim\/agent\/stream/);
  assert.match(codePanelSource, /mode:\s*'modify'/);
  assert.match(codePanelSource, /currentCode/);
});
