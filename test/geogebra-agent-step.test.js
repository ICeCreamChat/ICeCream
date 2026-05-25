import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';
import {
  buildGeoGebraAgentStepRequest,
  createGeoGebraAgentStep,
} from '../services/geogebra/geogebra-agent.js';

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, base: `http://127.0.0.1:${address.port}` });
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('GeoGebra agent-step request preserves canvas, selected objects and history', () => {
  const request = buildGeoGebraAgentStepRequest({
    message: '继续画轨迹',
    canvas: { objects: [{ name: 'M', type: 'point' }] },
    selectedObjects: ['M'],
    commandHistory: [{ command: 'M = Midpoint(O, P)', success: true }],
    preferredPerspective: 'G',
  });

  assert.equal(request.message, '继续画轨迹');
  assert.equal(request.canvas.elements[0].name, 'M');
  assert.deepEqual(request.selectedObjects, ['M']);
  assert.equal(request.commandHistory.length, 1);
});

test('GeoGebra agent-step returns execute for deterministic high confidence problems', async () => {
  const payload = await createGeoGebraAgentStep({
    message: '已知圆C是以C(0,3)为圆心、3为半径的圆。过原点O作圆C的任意弦OP,求OP的中点M的轨迹方程。',
  }, { env: {} });

  assert.equal(payload.success, true);
  assert.equal(payload.intent, 'geogebra');
  assert.equal(payload.data.status, 'execute');
  assert.equal(payload.data.deterministic, true);
  assert.ok(payload.data.commands.includes('locusM = Circle((0, 1.5), 1.5)'));
});

test('GeoGebra agent-step asks for clarification when no template and no AI are available', async () => {
  const payload = await createGeoGebraAgentStep({
    message: '帮我画这道题',
  }, { env: {} });

  assert.equal(payload.success, true);
  assert.equal(payload.data.status, 'clarify');
  assert.equal(payload.data.commands.length, 0);
  assert.match(payload.data.followUp, /补充|条件|题目/);
});

test('Gateway exposes GeoGebra manual search and agent-step APIs', async () => {
  const { server, base } = await listen(createGatewayApp({ isDev: false }));
  try {
    const manualResponse = await fetch(`${base}/api/geogebra/manual/search?q=Locus&limit=3`);
    const manualPayload = await manualResponse.json();
    assert.equal(manualResponse.status, 200);
    assert.equal(manualPayload.success, true);
    assert.ok(manualPayload.data.matches.some(match => match.title === 'Locus'));

    const stepResponse = await fetch(`${base}/api/geogebra/studio/agent-step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '已知圆C是以C(0,3)为圆心、3为半径的圆。过原点O作圆C的任意弦OP,求OP的中点M的轨迹方程。',
      }),
    });
    const stepPayload = await stepResponse.json();
    assert.equal(stepResponse.status, 200);
    assert.equal(stepPayload.data.status, 'execute');
  } finally {
    await close(server);
  }
});
