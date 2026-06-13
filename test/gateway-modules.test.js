import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGatewayApp, setDevelopmentStaticHeaders } from '../gateway/app.js';
import { getConfidenceThreshold } from '../gateway/middleware/intent-router.js';
import {
    createStaticVideoProxy,
    isAllowedManimStaticFilename,
    normalizeManimServiceUrl,
} from '../gateway/routes/static-video.js';
import { cleanupUploadsDirectory, ensureDirectory } from '../gateway/startup/uploads.js';

test('gateway app can be constructed without starting the HTTP listener', () => {
    const app = createGatewayApp({ isDev: false });

    assert.equal(typeof app, 'function');
    assert.equal(app.get('trust proxy'), 1);
});

test('gateway mounts timetable constraint chat APIs under tools timetable routes', async () => {
    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/tools/timetable/constraints/chat/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                constraints: [{
                    id: 'draft-1',
                    type: 'teacher_daily_limit',
                    targetType: 'teacher',
                    targetId: 't_math',
                    targetName: 'Math Teacher',
                    value: 4,
                    status: 'effective',
                }],
                project: {
                    teachers: [{ id: 't_math', name: 'Math Teacher' }],
                    classes: [{ id: 'c1', name: '1' }],
                    subjects: [{ id: 'math', name: 'Math' }],
                },
            }),
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.match(payload.data.conversationId, /^conv_/);
        assert.match(payload.data.welcomeMessage, /1/);
        assert.equal(payload.data.constraints.length, 1);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('development static headers prevent stale GeoGebra runtime caching', () => {
    const headers = {};
    const res = {
        setHeader(name, value) {
            headers[name] = value;
        },
    };

    setDevelopmentStaticHeaders(res, 'D:/607document/ICeCream/public/vendor/geogebra/deployggb.js');

    assert.match(headers['Cache-Control'], /no-store/);
    assert.equal(headers.Pragma, 'no-cache');
    assert.equal(headers.Expires, '0');
});

test('Manim static proxy URL normalization is stable', () => {
    assert.equal(normalizeManimServiceUrl('localhost:8001/'), 'http://localhost:8001');
    assert.equal(normalizeManimServiceUrl('http://localhost:8001/'), 'http://localhost:8001');
    assert.equal(normalizeManimServiceUrl('https://example.com/manim/'), 'https://example.com/manim');
    assert.equal(normalizeManimServiceUrl(''), 'http://localhost:8001');
});

test('Manim static proxy allows generated frame images and rejects unsafe names', async () => {
    assert.equal(isAllowedManimStaticFilename('studio_abc_frame_03.png'), true);
    assert.equal(isAllowedManimStaticFilename('video_abc.mp4'), true);
    assert.equal(isAllowedManimStaticFilename('../secret.png'), false);
    assert.equal(isAllowedManimStaticFilename('nested/file.png'), false);
    assert.equal(isAllowedManimStaticFilename('script.js'), false);

    let proxiedUrl = '';
    const proxy = createStaticVideoProxy({
        manimServiceUrl: 'localhost:8001/',
        fetchImpl: async url => {
            proxiedUrl = url;
            return {
                ok: true,
                status: 200,
                headers: { get: name => (name === 'content-type' ? 'image/png' : null) },
            };
        },
        logger: { error() {} },
    });

    const res = {
        statusCode: 200,
        headers: {},
        setHeader(name, value) {
            this.headers[name] = value;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        send(body) {
            this.body = body;
            return this;
        },
        end(body = '') {
            this.body = body;
            return this;
        },
    };

    await proxy(
        {
            params: { filename: 'studio_abc_frame_03.png' },
            originalUrl: '/static/studio_abc_frame_03.png?t=1',
        },
        res,
    );

    assert.equal(proxiedUrl, 'http://localhost:8001/static/studio_abc_frame_03.png?t=1');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'image/png');

    const rejected = { ...res, headers: {}, body: undefined, statusCode: 200 };
    await proxy(
        {
            params: { filename: '..%2Fsecret.png' },
            originalUrl: '/static/..%2Fsecret.png',
        },
        rejected,
    );
    assert.equal(rejected.statusCode, 404);
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

test('seating OCR reuses the shared MinerU zip downloader', async () => {
    const source = await readFile(new URL('../gateway/services/ocr.js', import.meta.url), 'utf8');

    assert.match(source, /fetchMineruZipWithRetry/);
    assert.match(source, /canAttemptMineruDownload/);
    assert.doesNotMatch(source, /fetch\(extractResult\.full_zip_url\)/);
});

test('solver diagram detection checks MinerU availability before running Layer 0', async () => {
    const source = await readFile(new URL('../services/solver/diagram-detector.js', import.meta.url), 'utf8');

    assert.match(source, /canAttemptMineruDownload/);
    assert.match(source, /MinerU .*cooldown|MinerU.*冷却|MinerU.*unavailable/);
});
