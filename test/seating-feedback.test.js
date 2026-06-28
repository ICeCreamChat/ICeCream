import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';
import { cleanupSeatingFeedback, submitSeatingFeedback } from '../gateway/services/seating-feedback.js';

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

test('POST /api/tools/seating/feedback rejects empty feedback', async () => {
  const appServer = createServer(createGatewayApp({ isDev: false }));
  const appBase = await listen(appServer);

  try {
    const response = await fetch(`${appBase}/api/tools/seating/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.success, false);
    assert.match(payload.error, /反馈|message/i);
  } finally {
    await close(appServer);
  }
});

test('POST /api/tools/seating/feedback saves anonymized feedback without email config', async () => {
  const originalLogDir = process.env.FEEDBACK_LOG_DIR;
  const originalTo = process.env.FEEDBACK_TO_EMAIL;
  const logDir = await mkdtemp(path.join(tmpdir(), 'icecream-feedback-route-'));
  process.env.FEEDBACK_LOG_DIR = logDir;
  delete process.env.FEEDBACK_TO_EMAIL;

  const appServer = createServer(createGatewayApp({ isDev: false }));
  const appBase = await listen(appServer);

  try {
    const response = await fetch(`${appBase}/api/tools/seating/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'stu_001 的右护法没有换成功',
        expected: '希望右护法换成成绩一般的男生',
        category: 'guardian',
        severity: 'blocking',
        snapshot: {
          students: [{ anonId: 'stu_001', gender: 'M', gradeBand: '80-89' }],
          layout: [['stu_001']],
        },
        client: { url: 'http://localhost/tool/seating' },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.match(payload.data.id, /^FB-/);
    assert.equal(payload.data.emailSent, false);

    const content = await readFile(path.join(logDir, 'seating-feedback.jsonl'), 'utf8');
    assert.match(content, /stu_001/);
    assert.doesNotMatch(content, /张三|李四/);
  } finally {
    await close(appServer);
    restoreEnv('FEEDBACK_LOG_DIR', originalLogDir);
    restoreEnv('FEEDBACK_TO_EMAIL', originalTo);
  }
});

test('POST /api/tools/seating/feedback saves screenshot asset without storing base64 in jsonl', async () => {
  const originalLogDir = process.env.FEEDBACK_LOG_DIR;
  const originalTo = process.env.FEEDBACK_TO_EMAIL;
  const logDir = await mkdtemp(path.join(tmpdir(), 'icecream-feedback-shot-'));
  process.env.FEEDBACK_LOG_DIR = logDir;
  delete process.env.FEEDBACK_TO_EMAIL;

  const appServer = createServer(createGatewayApp({ isDev: false }));
  const appBase = await listen(appServer);

  try {
    const response = await fetch(`${appBase}/api/tools/seating/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'frontend screenshot issue',
        category: 'ui',
        severity: 'workaround',
        screenshot: {
          included: true,
          privacyMode: 'redacted',
          mimeType: 'image/jpeg',
          dataUrl: 'data:image/jpeg;base64,aGVsbG8=',
          width: 320,
          height: 180,
          capturedAt: '2026-05-05T00:00:00.000Z',
          target: 'seating-tool',
        },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);

    const content = await readFile(path.join(logDir, 'seating-feedback.jsonl'), 'utf8');
    const record = JSON.parse(content.trim());
    assert.equal(record.raw.screenshot.included, true);
    assert.equal(record.raw.screenshot.privacyMode, 'redacted');
    assert.equal(record.raw.screenshot.mimeType, 'image/jpeg');
    assert.equal(record.raw.screenshot.fileName, `seating-feedback-assets/${record.id}.jpg`);
    assert.equal(record.raw.screenshot.byteLength, 5);
    assert.equal(record.raw.screenshot.dataUrl, undefined);
    assert.doesNotMatch(content, /data:image/);

    const asset = await readFile(path.join(logDir, record.raw.screenshot.fileName));
    assert.equal(asset.toString('utf8'), 'hello');
  } finally {
    await close(appServer);
    restoreEnv('FEEDBACK_LOG_DIR', originalLogDir);
    restoreEnv('FEEDBACK_TO_EMAIL', originalTo);
  }
});

test('GET /api/tools/seating/diagnostics returns redacted service state and recent logs', async () => {
  const originalLogDir = process.env.DIAGNOSTIC_LOG_DIR;
  const originalFeedbackLogDir = process.env.FEEDBACK_LOG_DIR;
  const originalTo = process.env.FEEDBACK_TO_EMAIL;
  const originalFrom = process.env.FEEDBACK_FROM_EMAIL;
  const originalSmtpHost = process.env.SMTP_HOST;
  const originalSmtpUser = process.env.SMTP_USER;
  const originalSmtpPass = process.env.SMTP_PASS;
  const originalSolverUrl = process.env.TIMEFOLD_SOLVER_URL;
  const originalApiBase = process.env.DEEPSEEK_API_BASE;
  const originalApiKey = process.env.DEEPSEEK_API_KEY;

  const logDir = await mkdtemp(path.join(tmpdir(), 'icecream-diagnostics-'));
  await writeFile(path.join(logDir, 'timefold.log'), [
    'solver started',
    'Authorization: Bearer live-secret-token',
    'jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
    'smtp pass CHhYGwHGJTwStdd2',
  ].join('\n'), 'utf8');

  process.env.DIAGNOSTIC_LOG_DIR = logDir;
  process.env.FEEDBACK_LOG_DIR = logDir;
  process.env.FEEDBACK_TO_EMAIL = 'teacher@example.com';
  process.env.FEEDBACK_FROM_EMAIL = 'icecream@example.com';
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_USER = 'icecream@example.com';
  process.env.SMTP_PASS = 'smtp-secret-value';
  delete process.env.TIMEFOLD_SOLVER_URL;
  process.env.DEEPSEEK_API_BASE = 'https://api.example.test';
  delete process.env.DEEPSEEK_API_KEY;

  const appServer = createServer(createGatewayApp({ isDev: false }));
  const appBase = await listen(appServer);

  try {
    const response = await fetch(`${appBase}/api/tools/seating/diagnostics`);
    const payload = await response.json();
    const serialized = JSON.stringify(payload);

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.diagnosticsVersion, 2);
    assert.equal(payload.data.ai.online, false);
    assert.equal(payload.data.timefold.configured, false);
    assert.equal(payload.data.services.feedbackEmailConfigured, true);
    assert.equal(payload.data.services.feedbackLogWritable, true);
    assert.match(serialized, /\[REDACTED\]/);
    assert.doesNotMatch(serialized, /live-secret-token/);
    assert.doesNotMatch(serialized, /smtp-secret-value/);
    assert.doesNotMatch(serialized, /CHhYGwHGJTwStdd2/);
    assert.doesNotMatch(serialized, /eyJhbGci/);
  } finally {
    await close(appServer);
    restoreEnv('DIAGNOSTIC_LOG_DIR', originalLogDir);
    restoreEnv('FEEDBACK_LOG_DIR', originalFeedbackLogDir);
    restoreEnv('FEEDBACK_TO_EMAIL', originalTo);
    restoreEnv('FEEDBACK_FROM_EMAIL', originalFrom);
    restoreEnv('SMTP_HOST', originalSmtpHost);
    restoreEnv('SMTP_USER', originalSmtpUser);
    restoreEnv('SMTP_PASS', originalSmtpPass);
    restoreEnv('TIMEFOLD_SOLVER_URL', originalSolverUrl);
    restoreEnv('DEEPSEEK_API_BASE', originalApiBase);
    restoreEnv('DEEPSEEK_API_KEY', originalApiKey);
  }
});

test('submitSeatingFeedback sends email when SMTP config is available', async () => {
  const logDir = await mkdtemp(path.join(tmpdir(), 'icecream-feedback-mail-'));
  const sent = [];
  const mailer = {
    async sendMail(message) {
      sent.push(message);
      return { messageId: 'test-message-id' };
    },
  };

  const result = await submitSeatingFeedback({
    body: {
      message: 'stu_002 的座位结果不符合要求',
      expected: '希望按照五列两人一组',
      category: 'result',
      severity: 'workaround',
      snapshot: {
        layout: [['stu_002']],
        backendDiagnostics: {
          ai: { online: false, reason: 'not_configured' },
          timefold: { configured: true, online: false, fallbackReason: 'timeout' },
          services: { feedbackEmailConfigured: true },
          recentLogs: {
            'timefold.err.log': ['Bearer live-secret-token', 'SMTP_PASS=secret'],
          },
        },
        diagnosticEvents: [
          { type: 'generate_seating_failed', detail: { error: 'capacity mismatch', token: 'live-secret-token' } },
        ],
        lastErrors: [{ message: 'Bearer live-secret-token' }],
        arrangementSource: 'timefold_solver',
        arrangementStats: { solverUsed: true, hardScore: 0, softScore: 12, fallbackReason: null },
      },
      screenshot: {
        included: true,
        privacyMode: 'full',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,aGVsbG8=',
        width: 200,
        height: 120,
        capturedAt: '2026-05-05T00:00:00.000Z',
        target: 'seating-tool',
      },
      client: { theme: 'light', auth: 'Bearer live-secret-token' },
    },
    env: {
      FEEDBACK_LOG_DIR: logDir,
      FEEDBACK_TO_EMAIL: 'teacher@example.com',
      FEEDBACK_FROM_EMAIL: 'icecream@example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_USER: 'icecream@example.com',
      SMTP_PASS: 'secret',
    },
    mailer,
  });

  assert.equal(result.emailSent, true);
  assert.equal(result.aiSummarized, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'teacher@example.com');
  assert.match(sent[0].subject, /ICeCream 座位反馈/);
  assert.match(sent[0].text, /stu_002/);
  assert.match(sent[0].text, /Quick Diagnosis/);
  assert.match(sent[0].text, /Backend Diagnostics/);
  assert.match(sent[0].text, /diagnosticEvents/);
  assert.doesNotMatch(sent[0].text, /secret/);
  assert.doesNotMatch(sent[0].text, /live-secret-token/);
  assert.equal(sent[0].attachments.length, 1);
  assert.equal(sent[0].attachments[0].filename, `${result.id}.png`);
  assert.equal(sent[0].attachments[0].contentType, 'image/png');

  const content = await readFile(path.join(logDir, 'seating-feedback.jsonl'), 'utf8');
  assert.match(content, /"diagnosticsVersion":2/);
  assert.match(content, /backendDiagnostics/);
  assert.match(content, /"screenshot"/);
  assert.match(content, /seating-feedback-assets/);
  assert.doesNotMatch(content, /live-secret-token/);
  assert.doesNotMatch(content, /SMTP_PASS=secret/);
  assert.doesNotMatch(content, /data:image/);
});

test('submitSeatingFeedback ignores invalid screenshots while saving feedback', async () => {
  const logDir = await mkdtemp(path.join(tmpdir(), 'icecream-feedback-invalid-shot-'));

  const result = await submitSeatingFeedback({
    body: {
      message: 'feedback body is still valid',
      category: 'ui',
      severity: 'suggestion',
      screenshot: {
        included: true,
        privacyMode: 'redacted',
        mimeType: 'image/gif',
        dataUrl: 'data:text/plain;base64,aGVsbG8=',
        width: 10,
        height: 10,
        capturedAt: '2026-05-05T00:00:00.000Z',
        target: 'seating-tool',
      },
    },
    env: { FEEDBACK_LOG_DIR: logDir },
  });

  assert.match(result.id, /^FB-/);
  assert.equal(result.record.raw.screenshot, null);

  const content = await readFile(path.join(logDir, 'seating-feedback.jsonl'), 'utf8');
  assert.match(content, /feedback body is still valid/);
  assert.doesNotMatch(content, /data:text/);
});

test('cleanupSeatingFeedback removes expired records and screenshots only', async () => {
  const logDir = await mkdtemp(path.join(tmpdir(), 'icecream-feedback-cleanup-'));
  const assetDir = path.join(logDir, 'seating-feedback-assets');
  await mkdir(assetDir, { recursive: true });

  const oldRecord = {
    id: 'FB-OLD',
    createdAt: '2026-01-01T00:00:00.000Z',
    raw: { screenshot: { fileName: 'seating-feedback-assets/FB-OLD.jpg' } },
  };
  const recentRecord = {
    id: 'FB-RECENT',
    createdAt: '2026-06-27T00:00:00.000Z',
    raw: { screenshot: { fileName: 'seating-feedback-assets/FB-RECENT.jpg' } },
  };
  await writeFile(path.join(logDir, 'seating-feedback.jsonl'), [
    JSON.stringify(oldRecord),
    JSON.stringify(recentRecord),
    'not-json-but-should-be-kept',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(assetDir, 'FB-OLD.jpg'), 'old', 'utf8');
  await writeFile(path.join(assetDir, 'FB-RECENT.jpg'), 'recent', 'utf8');

  const result = await cleanupSeatingFeedback({
    env: { FEEDBACK_LOG_DIR: logDir },
    now: new Date('2026-06-28T00:00:00.000Z'),
    retentionDays: 30,
  });

  assert.equal(result.removedRecords, 1);
  assert.equal(result.removedAssets, 1);

  const content = await readFile(path.join(logDir, 'seating-feedback.jsonl'), 'utf8');
  assert.doesNotMatch(content, /FB-OLD/);
  assert.match(content, /FB-RECENT/);
  assert.match(content, /not-json-but-should-be-kept/);
  await assert.rejects(readFile(path.join(assetDir, 'FB-OLD.jpg')), /ENOENT/);
  assert.equal(await readFile(path.join(assetDir, 'FB-RECENT.jpg'), 'utf8'), 'recent');
});
