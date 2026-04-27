import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function aiResponse(content) {
  return JSON.stringify({
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
  });
}

function parsePayload(chunks) {
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return JSON.parse(body.messages.at(-1).content);
}

function createAiServer(handler) {
  return createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const payload = parsePayload(chunks);
      const content = handler(payload);
      res.setHeader('Content-Type', 'application/json');
      res.end(aiResponse(content));
    });
  });
}

function makeStudents(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `s${String(index + 1).padStart(2, '0')}`,
    name: `Student ${index + 1}`,
    grade: 70 + index,
    gender: index % 2 === 0 ? 'M' : 'F',
  }));
}

async function withAppAndAi(handler, run) {
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

test('POST /api/tools/seating/arrange uses AI rules and local algorithm for a 60-student room', async () => {
  const stages = [];
  const students = makeStudents(60);
  students[4].grade = 10;
  students[54].grade = 11;

  await withAppAndAi(payload => {
    stages.push(payload.stage);
    assert.equal(payload.stage, 'arrangement_spec');
    assert.equal(payload.studentCount, 60);
    assert.equal(Boolean(payload.students), false);
    return {
      groupSize: 3,
      aislePolicy: { verticalBetweenGroups: true, horizontalBetweenGroupRows: true },
      guardianPolicy: { enabled: true, strategy: 'lowest_grade' },
      layoutMode: 'grouped',
      notes: 'rules only',
    };
  }, async appBase => {
    const response = await fetch(`${appBase}/api/tools/seating/arrange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '60个人，三个人一组，每组之间留横过道和竖过道，成绩最差的坐在左右护法的位置',
        students,
        previousLayout: {
          rows: 6,
          cols: 8,
          cells: Array.from({ length: 6 }, () => Array(8).fill('seat')),
        },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.source, 'ai_spec_local_algorithm');
    assert.equal(payload.data.assignments.length, 58);
    assert.equal(payload.data.unassigned.length, 0);
    assert.deepEqual(new Set([payload.data.guardians.left, payload.data.guardians.right]), new Set(['s05', 's55']));
    assert.ok(payload.data.stats.appliedStrategies.includes('成绩最低护法'));
    assert.ok(payload.data.classroomLayout.rows > 6 || payload.data.classroomLayout.cols > 8);
    assert.equal(new Set(payload.data.assignments.map(item => item.studentId)).size, 58);
    assert.deepEqual(stages, ['arrangement_spec']);
  });
});

test('POST /api/tools/seating/arrange ignores previous 6x8 capacity unless the prompt asks to keep it', async () => {
  await withAppAndAi(payload => {
    assert.equal(payload.stage, 'arrangement_spec');
    return {
      groupSize: 1,
      aislePolicy: { verticalBetweenGroups: false, horizontalBetweenGroupRows: false },
      guardianPolicy: { enabled: false },
      layoutMode: 'standard',
    };
  }, async appBase => {
    const response = await fetch(`${appBase}/api/tools/seating/arrange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '100个人，普通教室，自动安排',
        students: makeStudents(100),
        previousLayout: {
          rows: 6,
          cols: 8,
          cells: Array.from({ length: 6 }, () => Array(8).fill('seat')),
        },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.assignments.length, 100);
    assert.equal(payload.data.unassigned.length, 0);
    assert.ok(payload.data.stats.regularSeatCount >= 100);
    assert.ok(payload.data.classroomLayout.rows !== 6 || payload.data.classroomLayout.cols !== 8);
  });
});
