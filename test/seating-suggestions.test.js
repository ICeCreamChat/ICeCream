import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';
import {
  buildSeatingSuggestionMessages,
  fallbackSeatingSuggestions,
  generateSeatingSuggestions,
  parseSuggestionContent,
} from '../gateway/services/seating-suggestions.js';

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

function makeAiResponse(content) {
  return {
    choices: [{ message: { content } }],
  };
}

function createAiServer(handler) {
  return createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const userPayload = JSON.parse(body.messages.at(-1).content);
      const content = handler(userPayload, body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(makeAiResponse(content)));
    });
  });
}

async function withGatewayAndAi(handler, run) {
  const originalBase = process.env.DEEPSEEK_API_BASE;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const originalModel = process.env.DEEPSEEK_CHAT_MODEL;

  const aiServer = createAiServer(handler);
  const aiBase = await listen(aiServer);
  process.env.DEEPSEEK_API_BASE = aiBase;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  process.env.DEEPSEEK_CHAT_MODEL = 'test-model';

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
    await close(aiServer);
    restoreEnv('DEEPSEEK_API_BASE', originalBase);
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
    restoreEnv('DEEPSEEK_CHAT_MODEL', originalModel);
  }
}

test('seating suggestion parser accepts JSON objects and arrays', () => {
  assert.deepEqual(
    parseSuggestionContent('{"suggestions":["试试：两人一组","两人一组",""]}', 5),
    ['两人一组']
  );
  assert.deepEqual(
    parseSuggestionContent('文字前缀 ["检查当前座位","把视力差的同学往前调"]', 2),
    ['检查当前座位', '把视力差的同学往前调']
  );
});

test('seating suggestion messages include current seating context', () => {
  const messages = buildSeatingSuggestionMessages({
    target: 'chat',
    text: '帮我看看',
    students: [
      { id: 's01', name: '张三', gender: 'M', grade: 88, height: 170 },
      { id: 's02', name: '李四', gender: 'F' },
    ],
    constraints: [{ type: 'front_row', target: '张三' }],
    strategy: { gradeStrategy: 'mixed' },
    layout: [['s01', null], [null, 's02']],
    rows: 2,
    cols: 2,
    history: [{ role: 'user', content: '检查一下' }],
    count: 4,
  });
  const payload = JSON.parse(messages.at(-1).content);

  assert.match(messages[0].content, /当前已有座位表/);
  assert.match(messages[0].content, /只推荐当前布局内的微调/);
  assert.match(messages[0].content, /不要主动推荐“重新生成、改布局、整班重排”/);
  assert.equal(payload.target, 'chat');
  assert.equal(payload.currentText, '帮我看看');
  assert.equal(payload.studentSummary.count, 2);
  assert.equal(payload.studentSummary.withGrade, 1);
  assert.equal(payload.studentSummary.withHeight, 1);
  assert.equal(payload.room.hasPlacedStudents, true);
});

test('seating suggestion prompt asks AI to complete non-empty current text', () => {
  const messages = buildSeatingSuggestionMessages({
    target: 'arrange',
    text: '按身高',
    students: [{ id: 's01', name: '张三', height: 170 }],
    count: 3,
  });

  assert.match(messages[0].content, /currentText 非空/);
  assert.match(messages[0].content, /自然补全/);
});

test('generateSeatingSuggestions returns arrange suggestions from AI JSON', async () => {
  let requested;
  const suggestions = await generateSeatingSuggestions({
    request: {
      target: 'arrange',
      text: '两人一组',
      students: [{ id: 's01', name: '张三', grade: 80 }],
      constraints: [],
      strategy: { heightOrder: true },
      layout: [],
      rows: 6,
      cols: 8,
      count: 2,
    },
    env: { DEEPSEEK_API_BASE: 'http://ai.test', DEEPSEEK_API_KEY: 'key', DEEPSEEK_MODEL: 'model' },
    fetchImpl: async (url, options) => {
      requested = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => makeAiResponse(JSON.stringify({
          suggestions: ['两人一组，中间留过道', '讲台旁安排左右护法'],
        })),
      };
    },
  });

  assert.equal(requested.url, 'http://ai.test/chat/completions');
  assert.equal(requested.body.response_format.type, 'json_object');
  assert.deepEqual(suggestions, ['两人一组，中间留过道', '讲台旁安排左右护法']);
});

test('POST /api/tools/seating/suggestions returns arrange suggestions', async () => {
  await withGatewayAndAi(payload => {
    assert.equal(payload.target, 'arrange');
    assert.equal(payload.studentSummary.count, 1);
    return JSON.stringify({ suggestions: ['按身高从前到后安排', '中间留过道'] });
  }, async appBase => {
    const response = await fetch(`${appBase}/api/tools/seating/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'arrange',
        text: '按身高',
        students: [{ id: 's01', name: '张三', height: 170 }],
        count: 2,
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data.suggestions, ['按身高从前到后安排', '中间留过道']);
  });
});

test('POST /api/tools/seating/suggestions returns chat suggestions with placed-seat context', async () => {
  await withGatewayAndAi(payload => {
    assert.equal(payload.target, 'chat');
    assert.equal(payload.room.hasPlacedStudents, true);
    return JSON.stringify({ suggestions: ['检查现在座位是否有冲突', '把张三和李四换一下'] });
  }, async appBase => {
    const response = await fetch(`${appBase}/api/tools/seating/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'chat',
        text: '检查',
        students: [{ id: 's01', name: '张三' }, { id: 's02', name: '李四' }],
        layout: [['s01', 's02']],
        count: 2,
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data.suggestions, ['检查现在座位是否有冲突', '把张三和李四换一下']);
  });
});

test('POST /api/tools/seating/suggestions falls back when AI content is invalid', async () => {
  await withGatewayAndAi(() => 'not json at all', async appBase => {
    const response = await fetch(`${appBase}/api/tools/seating/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'chat', layout: [], count: 3 }),
    });
    const payload = await response.json();
    const fallback = fallbackSeatingSuggestions({ target: 'chat', layout: [], count: 3 });

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data.suggestions, fallback);
  });
});
