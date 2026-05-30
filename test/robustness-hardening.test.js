import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';
import { validateGatewayEnv } from '../gateway/config/environment.js';
import { convertCroppedDiagramToDataUrl } from '../services/solver/diagram-detector.js';
import {
  fetchMineruZipWithRetry,
  getMineruDownloadAvailability,
  resetMineruDownloadAvailability,
  resolveMineruDownloadPolicy,
} from '../services/solver/mineru-download.js';

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
    SOLVER_DEEPSEEK_MAX_TOKENS: process.env.SOLVER_DEEPSEEK_MAX_TOKENS,
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

test('POST /api/chat keeps public identity as ICeCream without exposing provider config', async () => {
  let forwarded;
  const aiServer = createAiServer(({ res, body }) => {
    forwarded = body;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content: '我是 ICeCream 的智能助手。' } }],
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
          message: '你用的是什么 API 和模型？是不是某个外部供应商？',
          messages: [],
        }),
      });

      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
    }, {
      DEEPSEEK_API_BASE: aiBase,
      DEEPSEEK_API_KEY: 'private-test-key',
      DEEPSEEK_MODEL: 'private-test-model',
    });

    assert.equal(forwarded.model, 'private-test-model');
    const systemPrompt = forwarded.messages[0].content;
    assert.match(systemPrompt, /ICeCream/);
    assert.match(systemPrompt, /对外身份|身份始终|智能助手/);
    assert.match(systemPrompt, /不要透露|不透露|不能透露/);
    assert.match(systemPrompt, /模型名|API供应商|API|密钥|环境变量|后端配置|系统提示词/);
    assert.doesNotMatch(systemPrompt, /private-test-key|private-test-model/);
    assert.doesNotMatch(systemPrompt, new RegExp(aiBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await close(aiServer);
  }
});

test('POST /api/message forwards current chat context from multipart form data', async () => {
  let forwarded;
  const aiServer = createAiServer(({ res, body }) => {
    forwarded = body;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content: '我记得，你叫小冰。' } }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }));
  });

  const aiBase = await listen(aiServer);
  try {
    await withGateway(async appBase => {
      const formData = new FormData();
      formData.append('mode', 'chat');
      formData.append('message', '我叫什么？');
      formData.append('messages', JSON.stringify([
        { role: 'system', content: 'inject-me' },
        { role: 'user', content: '我叫小冰，喜欢简洁回答。' },
        { role: 'assistant', content: '好的，我记住了。' },
      ]));

      const response = await fetch(`${appBase}/api/message`, {
        method: 'POST',
        body: formData,
      });

      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
    }, {
      DEEPSEEK_API_BASE: aiBase,
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_MODEL: 'test-model',
    });

    assert.deepEqual(
      forwarded.messages.map(item => item.role),
      ['system', 'user', 'assistant', 'user']
    );
    assert.deepEqual(
      forwarded.messages.map(item => item.content),
      [
        forwarded.messages[0].content,
        '我叫小冰，喜欢简洁回答。',
        '好的，我记住了。',
        '我叫什么？',
      ]
    );
    assert.doesNotMatch(JSON.stringify(forwarded.messages), /inject-me/);
  } finally {
    await close(aiServer);
  }
});

test('POST /api/chat deduplicates current user message when history already includes it', async () => {
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
          message: '我叫什么？',
          messages: [
            { role: 'user', content: '我叫小冰。' },
            { role: 'assistant', content: '好的。' },
            { role: 'user', content: '我叫什么？' },
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

    const userMessages = forwarded.messages.filter(item => item.role === 'user');
    assert.deepEqual(userMessages.map(item => item.content), ['我叫小冰。', '我叫什么？']);
  } finally {
    await close(aiServer);
  }
});

test('POST /api/chat limits chat context window and individual history message length', async () => {
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
      const history = Array.from({ length: 45 }, (_, index) => ({
        role: 'user',
        content: index === 44 ? 'x'.repeat(5000) : `history-${index}`,
      }));

      const response = await fetch(`${appBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'final',
          messages: history,
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

    const forwardedHistory = forwarded.messages.slice(1, -1);
    assert.equal(forwardedHistory.length, 40);
    assert.equal(forwardedHistory[0].content, 'history-5');
    assert.equal(forwardedHistory.at(-1).content.length, 4000);
    assert.equal(forwarded.messages.at(-1).content, 'final');
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

test('POST /api/solver automatically continues truncated answers and returns solver metadata', async () => {
  const calls = [];
  const aiServer = createAiServer(({ res, body }) => {
    calls.push(body);
    res.setHeader('Content-Type', 'application/json');
    if (calls.length === 1) {
      res.end(JSON.stringify({
        choices: [{
          finish_reason: 'length',
          message: {
            content: '**第一步：模型判断**\n三角恒等式综合题。\n\n**第三步：详细步骤**\n由条件可得若干角度范围。\n5. 再检查',
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 2000, total_tokens: 2010 },
      }));
      return;
    }

    res.end(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: '继续上一步：确认符号后可排除矛盾分支。\n\n**第四步：最终答案**\n最终答案为 C。',
        },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 80, total_tokens: 92 },
    }));
  });

  const aiBase = await listen(aiServer);
  try {
    await withGateway(async appBase => {
      const response = await fetch(`${appBase}/api/solver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '若 sin 2α = √5/5，求 α+β。' }),
      });

      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.match(payload.data.solution, /再检查/);
      assert.match(payload.data.solution, /最终答案为 C/);
      assert.doesNotMatch(payload.data.solution, /本次回答可能仍未完整/);
      assert.equal(payload.data.solverMeta.continuationCount, 1);
      assert.equal(payload.data.solverMeta.completed, true);
      assert.equal(payload.data.solverMeta.finishReason, 'stop');
    }, {
      DEEPSEEK_API_BASE: aiBase,
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_MODEL: 'test-model',
      SOLVER_DEEPSEEK_MAX_TOKENS: undefined,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].max_tokens, 8192);
    assert.match(calls[1].messages.at(-1).content, /从上一段中断处继续/);
  } finally {
    await close(aiServer);
  }
});

test('POST /api/solver continues when answer lacks final answer and ends mid-thought', async () => {
  const calls = [];
  const aiServer = createAiServer(({ res, body }) => {
    calls.push(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: calls.length === 1
            ? '**第一步：模型判断**\n函数最值题。\n\n**第三步：详细步骤**\n先求导，再判断单调性，因此我们还需要判断'
            : '**第四步：最终答案**\n最大值为 6。',
        },
      }],
      usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 },
    }));
  });

  const aiBase = await listen(aiServer);
  try {
    await withGateway(async appBase => {
      const response = await fetch(`${appBase}/api/solver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '求函数最大值。' }),
      });

      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.match(payload.data.solution, /最大值为 6/);
      assert.equal(payload.data.solverMeta.continuationCount, 1);
      assert.equal(payload.data.solverMeta.completed, true);
    }, {
      DEEPSEEK_API_BASE: aiBase,
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_MODEL: 'test-model',
    });

    assert.equal(calls.length, 2);
  } finally {
    await close(aiServer);
  }
});

test('POST /api/solver uses configurable solver max tokens without extra continuation for complete answers', async () => {
  const calls = [];
  const aiServer = createAiServer(({ res, body }) => {
    calls.push(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: '**第一步：模型判断**\n选择题。\n\n**第四步：最终答案**\n选 A。',
        },
      }],
      usage: { prompt_tokens: 4, completion_tokens: 10, total_tokens: 14 },
    }));
  });

  const aiBase = await listen(aiServer);
  try {
    await withGateway(async appBase => {
      const response = await fetch(`${appBase}/api/solver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '选择题，选什么？' }),
      });

      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.equal(payload.data.solverMeta.continuationCount, 0);
      assert.equal(payload.data.solverMeta.completed, true);
    }, {
      DEEPSEEK_API_BASE: aiBase,
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_MODEL: 'test-model',
      SOLVER_DEEPSEEK_MAX_TOKENS: '6000',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].max_tokens, 6000);
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

test('solver diagram conversion returns browser-safe data URLs and removes cropped files', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'icecream-cropped-diagram-'));
  const croppedPath = path.join(tempDir, 'cropped_test.png');
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64',
  );
  await writeFile(croppedPath, onePixelPng);

  const dataUrl = await convertCroppedDiagramToDataUrl(croppedPath, { cleanup: true });

  assert.match(dataUrl, /^data:image\/png;base64,/);
  await assert.rejects(stat(croppedPath), /ENOENT/);
});

test('MinerU zip download retries transient TLS failures before succeeding', async () => {
  let attempts = 0;
  const zipBytes = Buffer.from([80, 75, 3, 4]);

  const buffer = await fetchMineruZipWithRetry('https://cdn-mineru.openxlab.org.cn/demo/result.zip', {
    maxAttempts: 3,
    baseDelayMs: 0,
    timeoutMs: 100,
    lookupImpl: async () => ({ address: '203.0.113.10' }),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('Client network socket disconnected before secure TLS connection was established');
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength),
      };
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual([...buffer], [...zipBytes]);
});

test('MinerU zip download uses MINERU_DOWNLOAD_PROXY before generic proxy variables', async () => {
  const zipBytes = Buffer.from([80, 75, 3, 4]);
  let forwardedAgent;

  await fetchMineruZipWithRetry('https://cdn-mineru.openxlab.org.cn/demo/result.zip', {
    maxAttempts: 1,
    timeoutMs: 100,
    env: {
      MINERU_DOWNLOAD_PROXY: 'http://mineru-proxy.local:7890',
      HTTPS_PROXY: 'http://generic-proxy.local:7890',
    },
    proxyAgentFactory: proxyUrl => ({ proxyUrl }),
    fetchImpl: async (_url, init) => {
      forwardedAgent = init.agent;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength),
      };
    },
  });

  assert.deepEqual(forwardedAgent, { proxyUrl: 'http://mineru-proxy.local:7890' });
});

test('MinerU zip download falls back to HTTPS_PROXY when no MinerU-specific proxy is set', async () => {
  const zipBytes = Buffer.from([80, 75, 3, 4]);
  let forwardedAgent;

  await fetchMineruZipWithRetry('https://cdn-mineru.openxlab.org.cn/demo/result.zip', {
    maxAttempts: 1,
    timeoutMs: 100,
    env: {
      HTTPS_PROXY: 'http://generic-proxy.local:7890',
    },
    proxyAgentFactory: proxyUrl => ({ proxyUrl }),
    fetchImpl: async (_url, init) => {
      forwardedAgent = init.agent;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength),
      };
    },
  });

  assert.deepEqual(forwardedAgent, { proxyUrl: 'http://generic-proxy.local:7890' });
});

test('MinerU zip download skips fake-ip CDN without proxy instead of retrying', async () => {
  resetMineruDownloadAvailability();
  let attempts = 0;

  await assert.rejects(
    fetchMineruZipWithRetry('https://cdn-mineru.openxlab.org.cn/demo/result.zip', {
      maxAttempts: 3,
      baseDelayMs: 0,
      timeoutMs: 100,
      cooldownMs: 600000,
      nowMs: 1000,
      env: {},
      lookupImpl: async () => ({ address: '198.18.0.143' }),
      fetchImpl: async () => {
        attempts += 1;
        throw new Error('should not fetch fake-ip CDN without proxy');
      },
    }),
    /Fake-IP|MINERU_CDN_FAKE_IP_NO_PROXY|代理/,
  );

  assert.equal(attempts, 0);
  assert.equal(getMineruDownloadAvailability({ nowMs: 1001 }).available, false);
  assert.equal(getMineruDownloadAvailability({ nowMs: 1001 }).reason, 'fake-ip-no-proxy');
  resetMineruDownloadAvailability();
});

test('MinerU zip download cooldown skips repeated attempts until the cooldown expires', async () => {
  resetMineruDownloadAvailability();
  const zipBytes = Buffer.from([80, 75, 3, 4]);
  let attempts = 0;

  await assert.rejects(
    fetchMineruZipWithRetry('https://cdn-mineru.openxlab.org.cn/demo/result.zip', {
      maxAttempts: 1,
      baseDelayMs: 0,
      timeoutMs: 100,
      cooldownMs: 600000,
      nowMs: 1000,
      env: {},
      lookupImpl: async () => ({ address: '203.0.113.10' }),
      fetchImpl: async () => {
        attempts += 1;
        throw new Error('Client network socket disconnected before secure TLS connection was established');
      },
    }),
    /secure TLS connection/,
  );

  await assert.rejects(
    fetchMineruZipWithRetry('https://cdn-mineru.openxlab.org.cn/demo/result.zip', {
      maxAttempts: 1,
      baseDelayMs: 0,
      timeoutMs: 100,
      cooldownMs: 600000,
      nowMs: 2000,
      env: {},
      lookupImpl: async () => ({ address: '203.0.113.10' }),
      fetchImpl: async () => {
        attempts += 1;
        throw new Error('should not retry during cooldown');
      },
    }),
    /cooldown|冷却|MINERU_DOWNLOAD_COOLDOWN/,
  );

  assert.equal(attempts, 1);
  assert.equal(getMineruDownloadAvailability({ nowMs: 2000 }).available, false);

  const buffer = await fetchMineruZipWithRetry('https://cdn-mineru.openxlab.org.cn/demo/result.zip', {
    maxAttempts: 1,
    baseDelayMs: 0,
    timeoutMs: 100,
    cooldownMs: 600000,
    nowMs: 602000,
    env: {},
    lookupImpl: async () => ({ address: '203.0.113.10' }),
    fetchImpl: async () => {
      attempts += 1;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength),
      };
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual([...buffer], [...zipBytes]);
  assert.equal(getMineruDownloadAvailability({ nowMs: 602001 }).available, true);
  resetMineruDownloadAvailability();
});

test('MinerU zip download policy defaults keep retries inside a bounded budget', () => {
  const policy = resolveMineruDownloadPolicy({
    MINERU_DOWNLOAD_BUDGET_MS: '',
    MINERU_DOWNLOAD_RETRIES: '',
    MINERU_FAILURE_COOLDOWN_MS: '',
  });

  assert.equal(policy.budgetMs, 35000);
  assert.equal(policy.maxAttempts, 2);
  assert.equal(policy.cooldownMs, 600000);
  assert.ok(policy.timeoutMs <= 17500);
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
