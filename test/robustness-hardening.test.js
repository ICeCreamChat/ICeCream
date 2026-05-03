import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';
import { validateGatewayEnv } from '../gateway/config/environment.js';

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

function createAiServer(handler) {
  return createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      handler({ req, res, body });
    });
  });
}

async function withGateway(run, env = {}) {
  const originals = {
    DEEPSEEK_API_BASE: process.env.DEEPSEEK_API_BASE,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
    DEEPSEEK_CHAT_MODEL: process.env.DEEPSEEK_CHAT_MODEL,
  };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

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
    for (const [key, value] of Object.entries(originals)) {
      restoreEnv(key, value);
    }
  }
}

test('POST /api/chat rejects overlong message with 400', async () => {
  await withGateway(async appBase => {
    const response = await fetch(`${appBase}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'a'.repeat(10001), messages: [] }),
    });

    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.success, false);
    assert.match(payload.error, /消息过长/);
  });
});

test('POST /api/chat filters client system role before forwarding upstream', async () => {
  let forwarded;
  const aiServer = createAiServer(({ res, body }) => {
    forwarded = body;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });

  const aiBase = await listen(aiServer);
  try {
    await withGateway(async appBase => {
      const response = await fetch(`${appBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: '',
          messages: [
            { role: 'system', content: 'inject-me' },
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
          ],
        }),
      });

      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
    }, {
      DEEPSEEK_API_BASE: aiBase,
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_MODEL: 'test-model',
    });

    const roles = forwarded.messages.map(item => item.role);
    assert.deepEqual(roles, ['system', 'user', 'assistant']);
    assert.doesNotMatch(JSON.stringify(forwarded.messages), /inject-me/);
  } finally {
    await close(aiServer);
  }
});

test('POST /api/chat/stream gracefully returns upstream errors as SSE payload', async () => {
  const aiServer = createAiServer(({ res }) => {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'upstream-failed' } }));
  });

  const aiBase = await listen(aiServer);
  try {
    await withGateway(async appBase => {
      const response = await fetch(`${appBase}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'stream please', messages: [] }),
      });

      const text = await response.text();
      assert.equal(response.status, 200);
      assert.match(text, /upstream-failed|API Error/);
    }, {
      DEEPSEEK_API_BASE: aiBase,
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_MODEL: 'test-model',
    });
  } finally {
    await close(aiServer);
  }
});

test('POST /api/solver rejects unrecognized base64 image', async () => {
  await withGateway(async appBase => {
    const response = await fetch(`${appBase}/api/solver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: 'data:image/png;base64,NOT_VALID_BASE64_IMAGE' }),
    });

    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.success, false);
    assert.match(payload.error, /无法识别的图片格式|图片过大/);
  });
});

test('POST /api/tools/seating/plan returns failure when upstream AI is non-2xx', async () => {
  const aiServer = createAiServer(({ res }) => {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'plan-upstream-down' } }));
  });

  const aiBase = await listen(aiServer);
  try {
    await withGateway(async appBase => {
      const response = await fetch(`${appBase}/api/tools/seating/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '两人一组', rows: 6, cols: 8, guardiansEnabled: false }),
      });

      const payload = await response.json();
      assert.equal(response.status, 500);
      assert.equal(payload.success, false);
      assert.match(payload.error, /plan-upstream-down|AI API 返回 503/);
    }, {
      DEEPSEEK_API_BASE: aiBase,
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_CHAT_MODEL: 'test-model',
    });
  } finally {
    await close(aiServer);
  }
});

test('POST /api/tools/seating/chat returns failure when upstream AI is non-2xx', async () => {
  const aiServer = createAiServer(({ res }) => {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'chat-upstream-down' } }));
  });

  const aiBase = await listen(aiServer);
  try {
    await withGateway(async appBase => {
      const response = await fetch(`${appBase}/api/tools/seating/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: '把张三和李四换一下',
          layout: [['s01', 's02'], [null, null]],
          students: [
            { id: 's01', name: '张三', gender: 'M', grade: 80 },
            { id: 's02', name: '李四', gender: 'F', grade: 82 },
          ],
          rows: 2,
          cols: 2,
          guardians: [null, null],
        }),
      });

      const payload = await response.json();
      assert.equal(response.status, 500);
      assert.equal(payload.success, false);
      assert.match(payload.error, /chat-upstream-down|AI API 返回 502/);
    }, {
      DEEPSEEK_API_BASE: aiBase,
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_CHAT_MODEL: 'test-model',
    });
  } finally {
    await close(aiServer);
  }
});

test('validateGatewayEnv warns when DEEPSEEK_API_BASE is missing', () => {
  const logs = [];
  const warnings = validateGatewayEnv(
    {
      DEEPSEEK_API_KEY: 'test-key',
      SILICONFLOW_API_KEY: 'test-sf-key',
    },
    { log: line => logs.push(String(line)) }
  );

  assert.ok(warnings.some(item => item.includes('DEEPSEEK_API_BASE is missing')));
  assert.ok(logs.length > 0);
});
