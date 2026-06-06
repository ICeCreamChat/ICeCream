import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { sanitizeHtml } from '../public/js/utils/sanitize.js';
import {
  buildCorsOptions,
  isAllowedImageMime,
  sanitizeUploadFilename,
} from '../gateway/security.js';
import { buildRenderPayload } from '../services/manim/manim-client.js';

test('sanitizeHtml removes executable HTML while preserving safe markup', () => {
  const dirty = '<p>Hello <strong>world</strong></p><img src=x onerror=alert(1)><script>alert(1)</script><a href="javascript:alert(1)">x</a>';
  const clean = sanitizeHtml(dirty);

  assert.match(clean, /<strong>world<\/strong>/);
  assert.doesNotMatch(clean, /script/i);
  assert.doesNotMatch(clean, /onerror/i);
  assert.doesNotMatch(clean, /javascript:/i);
});

test('upload filenames are basename-only and image uploads are whitelisted', () => {
  assert.equal(sanitizeUploadFilename('../evil.svg'), 'evil.svg');
  assert.equal(sanitizeUploadFilename('..\\evil<script>.png'), 'evil_script_.png');
  assert.equal(sanitizeUploadFilename(''), 'upload');

  assert.equal(isAllowedImageMime('image/png'), true);
  assert.equal(isAllowedImageMime('image/jpeg'), true);
  assert.equal(isAllowedImageMime('image/svg+xml'), false);
  assert.equal(isAllowedImageMime('application/javascript'), false);
});

test('default CORS origins include the configured local gateway port', async () => {
  const options = buildCorsOptions({ PORT: '3001' });
  const checkOrigin = origin => new Promise((resolve, reject) => {
    options.origin(origin, (error, allowed) => {
      if (error) reject(error);
      else resolve(allowed);
    });
  });

  assert.equal(await checkOrigin('http://127.0.0.1:3001'), true);
  assert.equal(await checkOrigin('http://localhost:3001'), true);
  await assert.rejects(checkOrigin('https://example.com'), /Not allowed by CORS/);
});

test('Manim render payload forwards stable client id', () => {
  assert.deepEqual(buildRenderPayload({ code: 'from manim import *', client_id: 'client_123' }), {
    code: 'from manim import *',
    client_id: 'client_123',
  });

  assert.equal(buildRenderPayload({ code: 'x = 1' }).client_id, 'gateway');
});

test('Manim service defaults to local-only binding and no startup port killing', async () => {
  const source = await readFile(new URL('../manim-service/main.py', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /uvicorn\.run\("main:app",\s*host="0\.0\.0\.0"/);
  assert.doesNotMatch(source, /free_port\(8001\)/);
  assert.doesNotMatch(source, /run_manim_safe,\s*cmd\)/);
});
