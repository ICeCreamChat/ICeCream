import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';
import {
  buildGeoGebraPlanRequest,
  buildGeoGebraStudioAdjustRequest,
  parseGeoGebraAgentReply,
} from '../services/geogebra/geogebra-agent.js';

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

test('GeoGebra plan request normalizes user input at the API boundary', () => {
  const requestPayload = buildGeoGebraPlanRequest({
    message: '  画一个三角形  ',
    canvas: {
      objects: [{ name: 'A', type: 'point', definition: '(0, 0)' }],
      elements: Array.from({ length: 120 }, (_, index) => ({ label: `A${index}`, type: 'point' })),
      expressions: [{ label: 'f' }],
    },
    selectedObjects: [{ name: 'A', type: 'point' }, 'B', 3, ''],
    preferredPerspective: 'T',
  });

  assert.equal(requestPayload.message, '画一个三角形');
  assert.equal(requestPayload.canvas.elements.length, 80);
  assert.equal(requestPayload.canvas.elements[0].name, 'A');
  assert.deepEqual(requestPayload.selectedObjects, [{ name: 'A', type: 'point' }, 'B', '3']);
  assert.equal(requestPayload.preferredPerspective, 'T');
});

test('GeoGebra agent reply parser keeps only executable command strings', () => {
  const parsedReply = parseGeoGebraAgentReply(`
    {"summary":"完成","perspective":"G","commands":["A = (0, 0)","RunClickScript(button1, \\"alert(1)\\")",42,"c = Circle(A, 2)"],"followUp":"拖动点 A"}
  `);

  assert.equal(parsedReply.summary, '完成');
  assert.equal(parsedReply.perspective, 'G');
  assert.deepEqual(parsedReply.commands, ['A = (0, 0)', 'c = Circle(A, 2)']);
});

test('GeoGebra Studio adjust request preserves selected objects and command history', () => {
  const requestPayload = buildGeoGebraStudioAdjustRequest({
    message: 'make selected point red and show its label',
    canvas: {
      objects: [{ name: 'A', type: 'point', definition: '(0, 0)' }],
    },
    selectedObjects: [{ name: 'A', type: 'point' }],
    commandHistory: [
      { command: 'A = (0, 0)', success: true, label: 'A' },
      { command: 'SetColor(A, "red")', success: false, error: 'bad color' },
    ],
    preferredPerspective: 'G',
  });

  assert.equal(requestPayload.message, 'make selected point red and show its label');
  assert.deepEqual(requestPayload.selectedObjects, [{ name: 'A', type: 'point' }]);
  assert.equal(requestPayload.commandHistory.length, 2);
  assert.equal(requestPayload.commandHistory[1].success, false);
  assert.equal(requestPayload.preferredPerspective, 'G');
});

test('Gateway exposes GeoGebra status and command search APIs', async () => {
  const appServer = createGatewayApp({ isDev: false }).listen(0, '127.0.0.1');
  const appBase = await new Promise(resolve => {
    appServer.on('listening', () => {
      const address = appServer.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  try {
    const statusResponse = await fetch(`${appBase}/api/geogebra/status`);
    const statusPayload = await statusResponse.json();
    assert.equal(statusResponse.status, 200);
    assert.equal(statusPayload.success, true);
    assert.equal(typeof statusPayload.data.assetsAvailable, 'boolean');
    assert.equal(statusPayload.data.commandIndexReady, true);

    const searchResponse = await fetch(`${appBase}/api/geogebra/commands/search?q=Circle&limit=3`);
    const searchPayload = await searchResponse.json();
    assert.equal(searchResponse.status, 200);
    assert.equal(searchPayload.success, true);
    assert.ok(searchPayload.data.matches.length > 0);
    assert.equal(searchPayload.data.matches[0].commandBase, 'Circle');
  } finally {
    await close(appServer);
  }
});

test('Gateway GeoGebra plan API uses DeepSeek-compatible chat completions', async () => {
  const originalBase = process.env.DEEPSEEK_API_BASE;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const originalModel = process.env.DEEPSEEK_MODEL;
  let observedRequest;

  const aiServer = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      observedRequest = {
        method: req.method,
        url: req.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        authorization: req.headers.authorization,
      };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: '已生成三角形',
              perspective: 'G',
              commands: ['A = (0, 0)', 'B = (4, 0)', 'C = (1, 3)', 'poly1 = Polygon(A, B, C)'],
              followUp: '可以拖动点 C 观察形状变化',
            }),
          },
        }],
      }));
    });
  });

  const aiBase = await listen(aiServer);
  process.env.DEEPSEEK_API_BASE = `${aiBase}/v1`;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  process.env.DEEPSEEK_MODEL = 'deepseek-chat';

  const appServer = createGatewayApp({ isDev: false }).listen(0, '127.0.0.1');
  const appBase = await new Promise(resolve => {
    appServer.on('listening', () => {
      const address = appServer.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  try {
    const response = await fetch(`${appBase}/api/geogebra/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '画一个可以拖动顶点的三角形',
        canvas: { elements: [], expressions: [] },
        selectedObjects: [],
        preferredPerspective: 'G',
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(observedRequest.method, 'POST');
    assert.equal(observedRequest.url, '/v1/chat/completions');
    assert.equal(observedRequest.authorization, 'Bearer test-key');
    assert.equal(observedRequest.body.model, 'deepseek-chat');
    assert.equal(payload.success, true);
    assert.equal(payload.intent, 'geogebra');
    assert.deepEqual(payload.data.commands.slice(0, 2), ['A = (0, 0)', 'B = (4, 0)']);
  } finally {
    await close(appServer);
    await close(aiServer);
    restoreEnv('DEEPSEEK_API_BASE', originalBase);
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
    restoreEnv('DEEPSEEK_MODEL', originalModel);
  }
});

test('Gateway GeoGebra Studio adjust API returns commands and studio notes', async () => {
  const originalBase = process.env.DEEPSEEK_API_BASE;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const originalModel = process.env.DEEPSEEK_MODEL;
  let observedTaskType = '';

  const aiServer = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const userPayload = JSON.parse(requestBody.messages.find(message => message.role === 'user').content);
      observedTaskType = userPayload.taskType;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: 'Adjusted selected object',
              perspective: 'G',
              commands: ['SetColor(A, 1, 0, 0)', 'ShowLabel(A, true)'],
              followUp: 'Drag A to continue exploring.',
              studioNotes: 'Selected object styling updated.',
            }),
          },
        }],
      }));
    });
  });

  const aiBase = await listen(aiServer);
  process.env.DEEPSEEK_API_BASE = `${aiBase}/v1`;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  process.env.DEEPSEEK_MODEL = 'deepseek-chat';

  const appServer = createGatewayApp({ isDev: false }).listen(0, '127.0.0.1');
  const appBase = await new Promise(resolve => {
    appServer.on('listening', () => {
      const address = appServer.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  try {
    const response = await fetch(`${appBase}/api/geogebra/studio/adjust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'make selected point red and show its label',
        canvas: { objects: [{ name: 'A', type: 'point' }] },
        selectedObjects: [{ name: 'A', type: 'point' }],
        commandHistory: [{ command: 'A = (0, 0)', success: true, label: 'A' }],
        preferredPerspective: 'G',
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(observedTaskType, 'studio_adjust');
    assert.equal(payload.success, true);
    assert.equal(payload.intent, 'geogebra');
    assert.deepEqual(payload.data.commands, ['SetColor(A, 1, 0, 0)', 'ShowLabel(A, true)']);
    assert.equal(payload.data.studioNotes, 'Selected object styling updated.');
  } finally {
    await close(appServer);
    await close(aiServer);
    restoreEnv('DEEPSEEK_API_BASE', originalBase);
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
    restoreEnv('DEEPSEEK_MODEL', originalModel);
  }
});
