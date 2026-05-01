import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';
import { buildSuggestionsPayload, getManimServiceUrl } from '../services/manim/manim-client.js';

const codePanelPath = new URL('../public/js/core/code-panel.js', import.meta.url);

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

test('Manim suggestions payload clamps count and keeps code', () => {
  assert.deepEqual(buildSuggestionsPayload({ code: 'from manim import *', count: 99 }), {
    code: 'from manim import *',
    count: 8,
  });
  assert.deepEqual(buildSuggestionsPayload({ code: '', count: 'bad' }), {
    code: '',
    count: 5,
  });
});

test('Manim service URL is read from current environment', () => {
  const originalUrl = process.env.MANIM_SERVICE_URL;
  const originalPort = process.env.MANIM_SERVICE_PORT;

  process.env.MANIM_SERVICE_URL = 'http://127.0.0.1:9123';
  assert.equal(getManimServiceUrl(), 'http://127.0.0.1:9123');

  delete process.env.MANIM_SERVICE_URL;
  process.env.MANIM_SERVICE_PORT = '8765';
  assert.equal(getManimServiceUrl(), 'http://localhost:8765');

  restoreEnv('MANIM_SERVICE_URL', originalUrl);
  restoreEnv('MANIM_SERVICE_PORT', originalPort);
});

test('POST /api/manim/suggestions forwards to Manim service suggestions API', async () => {
  const originalUrl = process.env.MANIM_SERVICE_URL;
  let observedRequest;

  const manimServer = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      observedRequest = {
        method: req.method,
        url: req.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ suggestions: ['把圆改成红色', '添加淡入动画'] }));
    });
  });

  const manimBase = await listen(manimServer);
  process.env.MANIM_SERVICE_URL = manimBase;
  const appServer = createGatewayApp({ isDev: false }).listen(0, '127.0.0.1');
  const appBase = await new Promise(resolve => {
    appServer.on('listening', () => {
      const address = appServer.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  try {
    const response = await fetch(`${appBase}/api/manim/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'Circle()', count: 2 }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(observedRequest.method, 'POST');
    assert.equal(observedRequest.url, '/api/suggestions');
    assert.deepEqual(observedRequest.body, { code: 'Circle()', count: 2 });
    assert.deepEqual(payload, {
      success: true,
      data: { suggestions: ['把圆改成红色', '添加淡入动画'] },
    });
  } finally {
    await close(appServer);
    await close(manimServer);
    restoreEnv('MANIM_SERVICE_URL', originalUrl);
  }
});

test('code panel uses AI Manim suggestions first and keeps local fallback', async () => {
  const source = await readFile(codePanelPath, 'utf8');

  assert.match(source, /fetch\('\/api\/manim\/suggestions'/);
  assert.match(source, /body: JSON\.stringify\(\{ code, count: 5 \}\)/);
  assert.match(source, /this\.suggestionController\?\.abort\(\)/);
  assert.match(source, /this\.getLocalSuggestions\(code\)/);
  assert.match(source, /setInterval\(cycle, 3000\)/);
  assert.match(source, /updatePlaceholder\(`试试：\$\{items\[idx % items\.length\]\}`\)/);
});
