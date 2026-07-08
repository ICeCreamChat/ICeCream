import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

import { startGateway } from '../gateway/server.js';

const QUIET_LOGGER = {
    log() {},
    info() {},
    warn() {},
    error(...args) {
        console.error(...args);
    },
};

function rememberEnv(keys = []) {
    return new Map(keys.map(key => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
    for (const [key, value] of snapshot.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

export async function withOpenedTimetablePage({ port, seedProject = null }, callback) {
    const host = '127.0.0.1';
    const baseUrl = `http://${host}:${port}`;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tt-ui-smoke-'));
    const envSnapshot = rememberEnv([
        'TIMETABLE_DATA_DIR',
        'DEEPSEEK_API_KEY',
        'OPENAI_API_KEY',
        'PORT',
        'HOST',
        'CORS_ORIGIN',
    ]);

    process.env.TIMETABLE_DATA_DIR = tempDir;
    process.env.DEEPSEEK_API_KEY = '';
    process.env.OPENAI_API_KEY = '';
    process.env.PORT = String(port);
    process.env.HOST = host;
    process.env.CORS_ORIGIN = `${baseUrl},http://localhost:${port}`;

    let server = null;
    let browser = null;
    let page = null;
    const pageErrors = [];
    const consoleErrors = [];

    try {
        ({ server } = startGateway({
            host,
            port,
            isDev: true,
            logger: QUIET_LOGGER,
        }));

        if (seedProject) {
            const projectPayload = { ...seedProject };
            delete projectPayload.version;
            const response = await fetch(`${baseUrl}/api/tools/timetable/project`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(projectPayload),
            });
            const payload = await response.json().catch(() => null);
            assert.equal(
                response.ok,
                true,
                `failed to seed timetable project: ${response.status} ${JSON.stringify(payload)}`,
            );
            assert.ok(payload?.data?.project, 'seeded timetable project should be returned');
        }

        browser = await chromium.launch({ headless: true });
        page = await browser.newPage();
        page.on('pageerror', error => pageErrors.push(error));
        page.on('console', message => {
            if (message.type() === 'error') consoleErrors.push(message.text());
        });

        await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(window.ICeCream?.appLauncher));
        await page.locator('#apps-btn').click();
        await page.waitForSelector('.app-launcher-overlay.active', { timeout: 10000 });
        await page.click('.app-card[data-tool="timetable"]');
        await page.waitForSelector('.tool-container.active', { timeout: 20000 });
        await page.waitForSelector('.tt-workbench', { timeout: 20000 });
        await page.waitForSelector('.tt-inspector', { timeout: 20000 });

        await callback({ page, baseUrl });

        assert.equal(
            pageErrors.length,
            0,
            `browser page errors: ${pageErrors.map(error => error.message).join(' | ')}`,
        );
        assert.equal(
            consoleErrors.length,
            0,
            `browser console errors: ${consoleErrors.join(' | ')}`,
        );
    } finally {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        if (server) await new Promise(resolve => server.close(resolve));
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
        restoreEnv(envSnapshot);
    }
}
