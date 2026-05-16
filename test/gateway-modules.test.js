import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';
import { getConfidenceThreshold } from '../gateway/middleware/intent-router.js';
import { normalizeManimServiceUrl } from '../gateway/routes/static-video.js';
import { cleanupUploadsDirectory, ensureDirectory } from '../gateway/startup/uploads.js';

test('gateway app can be constructed without starting the HTTP listener', () => {
    const app = createGatewayApp({ isDev: false });

    assert.equal(typeof app, 'function');
    assert.equal(app.get('trust proxy'), 1);
});

test('Manim static proxy URL normalization is stable', () => {
    assert.equal(normalizeManimServiceUrl('localhost:8001/'), 'http://localhost:8001');
    assert.equal(normalizeManimServiceUrl('http://localhost:8001/'), 'http://localhost:8001');
    assert.equal(normalizeManimServiceUrl('https://example.com/manim/'), 'https://example.com/manim');
    assert.equal(normalizeManimServiceUrl(''), 'http://localhost:8001');
});

test('intent confidence threshold is read from the provided environment', () => {
    assert.equal(getConfidenceThreshold({ INTENT_CONFIDENCE_THRESHOLD: '0.91' }), 0.91);
    assert.equal(getConfidenceThreshold({ INTENT_CONFIDENCE_THRESHOLD: 'invalid' }), 0.75);
    assert.equal(getConfidenceThreshold({}), 0.75);
});

test('intent confirmation response preserves the original message for resubmission', async () => {
    const source = await readFile(new URL('../gateway/middleware/intent-router.js', import.meta.url), 'utf8');

    assert.match(source, /const originalMessage = typeof message === 'string' \? message : ''/);
    assert.match(source, /originalMessage,/);
});

test('upload startup cleanup preserves sentinel and recent files', async () => {
    const uploadsDir = await mkdtemp(path.join(tmpdir(), 'icecream-uploads-'));
    const oldFile = path.join(uploadsDir, 'old.png');
    const recentFile = path.join(uploadsDir, 'recent.png');
    const sentinelFile = path.join(uploadsDir, '.gitkeep');

    await Promise.all([
        writeFile(oldFile, 'old'),
        writeFile(recentFile, 'recent'),
        writeFile(sentinelFile, ''),
    ]);

    const now = Date.now();
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);
    await utimes(oldFile, twoDaysAgo, twoDaysAgo);

    const result = cleanupUploadsDirectory(uploadsDir, {
        now,
        maxAgeMs: 24 * 60 * 60 * 1000,
    });

    assert.equal(result.deletedCount, 1);
    await assert.rejects(stat(oldFile), /ENOENT/);
    await assert.doesNotReject(stat(recentFile));
    await assert.doesNotReject(stat(sentinelFile));
});

test('ensureDirectory creates missing module-owned directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'icecream-dir-'));
    const nested = path.join(root, 'a', 'b');

    ensureDirectory(nested);

    const info = await stat(nested);
    assert.equal(info.isDirectory(), true);
});
