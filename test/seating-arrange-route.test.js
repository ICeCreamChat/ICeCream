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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function createSolverServer() {
  const jobs = new Map();
  let jobSequence = 0;

  return createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'POST' && pathname === '/seating-solutions') {
        const problem = await readJsonBody(req);
        const jobId = `test-job-${++jobSequence}`;
        jobs.set(jobId, {
          ...problem,
          jobId,
          hardScore: 0,
          softScore: 0,
          score: '0hard/0soft',
          students: (problem.students || []).map((student, index) => ({
            ...student,
            seat: problem.seats?.[index]?.id ?? null,
          })),
        });
        sendJson(res, 202, { jobId, solverStatus: 'SOLVING' });
        return;
      }

      const match = /^\/seating-solutions\/([^/]+)(\/status)?$/.exec(pathname);
      const jobId = match?.[1];
      const solution = jobId ? jobs.get(jobId) : null;
      if (!solution) {
        sendJson(res, 404, { error: 'job_not_found' });
        return;
      }
      if (req.method === 'GET' && match[2] === '/status') {
        sendJson(res, 200, { jobId, solverStatus: 'NOT_SOLVING', hardScore: 0 });
        return;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, solution);
        return;
      }
      if (req.method === 'DELETE') {
        jobs.delete(jobId);
        res.statusCode = 204;
        res.end();
        return;
      }
      sendJson(res, 405, { error: 'method_not_allowed' });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
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
  const originalSolverUrl = process.env.TIMEFOLD_SOLVER_URL;
  const originalSolverTimeout = process.env.TIMEFOLD_SOLVER_TIMEOUT;
  const aiServer = createAiServer(handler);
  const solverServer = createSolverServer();
  const [aiBase, solverBase] = await Promise.all([listen(aiServer), listen(solverServer)]);
  process.env.DEEPSEEK_API_BASE = aiBase;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  process.env.DEEPSEEK_CHAT_MODEL = 'test-model';
  process.env.TIMEFOLD_SOLVER_URL = solverBase;
  process.env.TIMEFOLD_SOLVER_TIMEOUT = '2';

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
    await close(solverServer);
    await close(aiServer);
    restoreEnv('DEEPSEEK_API_BASE', originalBase);
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
    restoreEnv('DEEPSEEK_CHAT_MODEL', originalModel);
    restoreEnv('TIMEFOLD_SOLVER_URL', originalSolverUrl);
    restoreEnv('TIMEFOLD_SOLVER_TIMEOUT', originalSolverTimeout);
  }
}

test('POST /api/tools/seating/arrange uses AI layout rules and Timefold assignment for a 60-student room', async () => {
  const stages = [];
  const students = makeStudents(60);
  students[4].grade = 10;
  students[54].grade = 11;

  await withAppAndAi(payload => {
    stages.push(payload.stage);
    assert.equal(payload.stage, 'layout_preview');
    assert.equal(payload.studentCount, 60);
    assert.equal(Boolean(payload.students), false);
    return {
      classroomLayout: {
        rows: 10,
        cols: 6,
        cells: Array.from({ length: 10 }, () => Array(6).fill('seat')),
        guardians: { enabled: false },
        template: 'ai-preview',
        groupSize: 3,
      },
      arrangementSpec: {
        groupSize: 3,
        aislePolicy: { verticalBetweenGroups: true, horizontalBetweenGroupRows: true },
        guardianPolicy: { enabled: true, strategy: 'lowest_grade' },
        layoutMode: 'grouped',
        notes: 'AI preview rules',
      },
      layoutIntent: { type: 'grouped', description: '三人一组' },
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
    assert.equal(payload.data.source, 'timefold_solver');
    assert.equal(payload.data.assignments.length, 58);
    assert.equal(payload.data.unassigned.length, 0);
    assert.deepEqual(new Set([payload.data.guardians.left, payload.data.guardians.right]), new Set(['s05', 's55']));
    assert.ok(payload.data.stats.appliedStrategies.includes('成绩最低护法'));
    assert.ok(payload.data.classroomLayout.rows > 6 || payload.data.classroomLayout.cols > 8);
    assert.equal(new Set(payload.data.assignments.map(item => item.studentId)).size, 58);
    assert.deepEqual(stages, ['layout_preview']);
  });
});

test('POST /api/tools/seating/arrange ignores previous 6x8 capacity unless the prompt asks to keep it', async () => {
  await withAppAndAi(payload => {
    assert.equal(payload.stage, 'layout_preview');
    return {
      classroomLayout: {
        rows: 10,
        cols: 10,
        cells: Array.from({ length: 10 }, () => Array(10).fill('seat')),
        guardians: { enabled: false },
        template: 'ai-preview',
        groupSize: 1,
      },
      arrangementSpec: {
        groupSize: 1,
        aislePolicy: { verticalBetweenGroups: false, horizontalBetweenGroupRows: false },
        guardianPolicy: { enabled: false },
        layoutMode: 'standard',
      },
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

test('POST /api/tools/seating/layout-preview returns AI layout without assignments', async () => {
  const students = makeStudents(6);
  const stages = [];

  await withAppAndAi(payload => {
    stages.push(payload.stage);
    assert.equal(payload.stage, 'layout_preview');
    assert.equal(payload.studentCount, 6);
    assert.equal(Boolean(payload.students), false);
    return {
      reply: '先看这个布局',
      classroomLayout: {
        rows: 2,
        cols: 4,
        cells: [
          ['seat', 'seat', 'aisle', 'seat'],
          ['seat', 'seat', 'aisle', 'seat'],
        ],
        guardians: { enabled: false },
        template: 'ai-preview',
        groupSize: 2,
      },
      layoutIntent: { type: 'grouped', description: '两人桌并留过道' },
      arrangementSpec: { groupSize: 2, layoutMode: 'grouped' },
    };
  }, async appBase => {
    const response = await fetch(`${appBase}/api/tools/seating/layout-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '两人一桌，过道要明显',
        students,
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.source, 'ai_layout_preview');
    assert.equal(payload.data.classroomLayout.rows, 2);
    assert.equal(Object.prototype.hasOwnProperty.call(payload.data, 'assignments'), false);
    assert.deepEqual(payload.data.layoutIntent, { type: 'grouped', description: '两人桌并留过道' });
    assert.deepEqual(stages, ['layout_preview']);
  });
});

test('POST /api/tools/seating/layout-preview rejects invalid requests', async () => {
  await withAppAndAi(() => {
    throw new Error('AI should not be called for invalid request');
  }, async appBase => {
    const response = await fetch(`${appBase}/api/tools/seating/layout-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '',
        students: makeStudents(2),
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.success, false);
    assert.match(payload.error, /请输入排座需求/);
  });
});

test('POST /api/tools/seating/arrange assigns a confirmed layout without another AI call', async () => {
  const students = makeStudents(4);
  let aiCalls = 0;

  await withAppAndAi(() => {
    aiCalls += 1;
    return {};
  }, async appBase => {
    const response = await fetch(`${appBase}/api/tools/seating/arrange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '确认后排学生',
        students,
        confirmedLayout: {
          rows: 2,
          cols: 2,
          cells: [
            ['seat', 'seat'],
            ['seat', 'seat'],
          ],
          guardians: { enabled: false },
          template: 'confirmed',
          groupSize: 1,
          localAisles: { vertical: [{ row: 0, col: 0 }], horizontal: [] },
        },
        arrangementSpec: { groupSize: 1, layoutMode: 'standard' },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(aiCalls, 0);
    assert.equal(payload.data.source, 'timefold_solver');
    assert.equal(payload.data.assignments.length, 4);
    assert.deepEqual(payload.data.classroomLayout.localAisles, {
      vertical: [{ row: 0, col: 0 }],
      horizontal: [],
    });
  });
});
