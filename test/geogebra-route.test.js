import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';
import {
  buildGeoGebraPlanRequest,
  buildGeoGebraStudioAdjustRequest,
  createGeoGebraPlan,
  parseGeoGebraAgentReply,
} from '../services/geogebra/geogebra-agent.js';
import { buildGeoGebraImagePlanBody, createGeoGebraImagePlan } from '../services/geogebra/geogebra-image-agent.js';

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

const REAL_LOCUS_PROBLEM_WITH_LATEX_ORIGIN = '\u3010\u4f8b1\u3011\u3001\u5df2\u77e5\u5706C\u662f\u4ee5C(0,3)\u4e3a\u5706\u5fc3\u30013\u4e3a\u534a\u5f84\u7684\u5706\u3002\u8fc7\u539f\u70b9$O$\u4f5c\u5706C\u7684\u4efb\u610f\u5f26OP,\u6c42OP\u7684\u4e2d\u70b9M\u7684\u8f68\u8ff9\u65b9\u7a0b\u3002';

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

test('GeoGebra image plan request combines OCR and visual context', () => {
  const requestPayload = buildGeoGebraImagePlanBody({
    message: '只画题图',
    canvas: JSON.stringify({ objects: [{ name: 'A', type: 'point' }] }),
    selectedObjects: JSON.stringify([{ name: 'A', type: 'point' }]),
    preferredPerspective: 'G',
  }, {
    extractedText: '已知三角形 ABC，D 是 BC 中点。',
    imageDescription: '图中有三角形 ABC 和中线 AD。',
  });

  assert.match(requestPayload.message, /只画题图/);
  assert.match(requestPayload.message, /已知三角形 ABC/);
  assert.match(requestPayload.message, /三角形 ABC 和中线 AD/);
  assert.deepEqual(requestPayload.canvas.objects, [{ name: 'A', type: 'point' }]);
  assert.deepEqual(requestPayload.selectedObjects, [{ name: 'A', type: 'point' }]);
  assert.equal(requestPayload.preferredPerspective, 'G');
});

test('GeoGebra deterministic planner handles circle chord midpoint locus problems exactly', async () => {
  const payload = await createGeoGebraPlan({
    message: '已知圆C是以C(0,3)为圆心、3为半径的圆。过原点O作圆C的任意弦OP,求OP的中点M的轨迹方程。',
  }, {
    env: {},
  });

  assert.equal(payload.success, true);
  assert.equal(payload.intent, 'geogebra');
  assert.equal(payload.data.deterministic, true);
  assert.match(payload.data.summary, /x\^2 \+ \(y - 1\.5\)\^2 = 2\.25/);
  assert.ok(payload.data.commands.includes('O = (0, 0)'));
  assert.ok(payload.data.commands.includes('C = (0, 3)'));
  assert.ok(payload.data.commands.includes('c = Circle(C, 3)'));
  assert.ok(payload.data.commands.includes('M = Midpoint(O, P)'));
  assert.ok(payload.data.commands.includes('K = (0, 1.5)'));
  assert.ok(payload.data.commands.includes('locusM = Circle(K, 1.5)'));
  assert.equal(payload.data.viewport?.equalScale, true);
  assert.equal(payload.data.demo?.type, 'trace');
  assert.equal(payload.data.demo?.autoPlay, true);
  assert.equal(payload.data.demo?.movingObject, 'P');
  assert.equal(payload.data.demo?.tracedObject, 'M');
  assert.equal(payload.data.demo?.path?.type, 'circle');
  assert.deepEqual(payload.data.demo?.path?.center, { x: 0, y: 3 });
  assert.equal(payload.data.demo?.path?.radius, 3);
});

test('GeoGebra image OCR text can trigger deterministic drawing without DeepSeek', async () => {
  const requestPayload = buildGeoGebraImagePlanBody({
    message: '请根据题目准确绘图',
  }, {
    extractedText: '已知圆C是以C(0,3)为圆心、3为半径的圆。过原点O作圆C的任意弦OP，求OP的中点M的轨迹方程。',
    imageDescription: '图中是坐标系和一个圆。',
  });
  const payload = await createGeoGebraPlan(requestPayload, { env: {} });

  assert.equal(payload.data.deterministic, true);
  assert.match(payload.data.summary, /M 的轨迹方程/);
  assert.ok(payload.data.commands.includes('K = (0, 1.5)'));
  assert.ok(payload.data.commands.includes('locusM = Circle(K, 1.5)'));
});

test('GeoGebra deterministic planner handles real OCR text without DeepSeek fallback', async () => {
  const payload = await createGeoGebraPlan({
    message: REAL_LOCUS_PROBLEM_WITH_LATEX_ORIGIN,
  }, {
    env: {},
  });

  assert.equal(payload.success, true);
  assert.equal(payload.data.deterministic, true);
  assert.match(payload.data.summary, /x\^2 \+ \(y - 1\.5\)\^2 = 2\.25/);
  assert.ok(payload.data.commands.includes('O = (0, 0)'));
  assert.ok(payload.data.commands.includes('C = (0, 3)'));
  assert.ok(payload.data.commands.includes('K = (0, 1.5)'));
  assert.ok(payload.data.commands.includes('locusM = Circle(K, 1.5)'));
});

test('GeoGebra image plan rejects requests without an uploaded image', async () => {
  await assert.rejects(
    () => createGeoGebraImagePlan({ message: '画题图' }, null),
    error => error.status === 400 && /上传题目图片/.test(error.message),
  );
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

test('Gateway GeoGebra Studio image parse API returns drawable commands', async () => {
  const originalBase = process.env.DEEPSEEK_API_BASE;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const originalModel = process.env.DEEPSEEK_MODEL;
  const originalMockVision = process.env.GEOGEBRA_IMAGE_FORCE_MOCK;
  let observedTaskType = '';
  let observedPrompt = '';

  const aiServer = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const userPayload = JSON.parse(requestBody.messages.find(message => message.role === 'user').content);
      observedTaskType = userPayload.taskType;
      observedPrompt = userPayload.request.message;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: '已根据题目图片生成等腰三角形',
              perspective: 'G',
              commands: ['A = (0, 3)', 'B = (-2, 0)', 'C = (2, 0)', 'poly1 = Polygon(A, B, C)'],
              followUp: '可以拖动点 A 观察图形变化。',
              studioNotes: '题图已转换为可交互构图。',
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
  process.env.GEOGEBRA_IMAGE_FORCE_MOCK = 'true';

  const appServer = createGatewayApp({ isDev: false }).listen(0, '127.0.0.1');
  const appBase = await new Promise(resolve => {
    appServer.on('listening', () => {
      const address = appServer.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  try {
    const pngBytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);
    const formData = new FormData();
    formData.append('message', '只画题目图形');
    formData.append('canvas', JSON.stringify({ objects: [] }));
    formData.append('selectedObjects', JSON.stringify([]));
    formData.append('preferredPerspective', 'G');
    formData.append('image', new Blob([pngBytes], { type: 'image/png' }), 'problem.png');

    const response = await fetch(`${appBase}/api/geogebra/studio/parse-image`, {
      method: 'POST',
      body: formData,
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(observedTaskType, 'plan');
    assert.match(observedPrompt, /只画题目图形/);
    assert.match(observedPrompt, /等腰三角形ABC/);
    assert.equal(payload.success, true);
    assert.equal(payload.intent, 'geogebra');
    assert.deepEqual(payload.data.commands.slice(0, 3), ['A = (0, 3)', 'B = (-2, 0)', 'C = (2, 0)']);
    assert.match(payload.data.extractedText, /已知/);
    assert.match(payload.data.imageDescription, /等腰三角形ABC/);
  } finally {
    await close(appServer);
    await close(aiServer);
    restoreEnv('DEEPSEEK_API_BASE', originalBase);
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
    restoreEnv('DEEPSEEK_MODEL', originalModel);
    restoreEnv('GEOGEBRA_IMAGE_FORCE_MOCK', originalMockVision);
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
