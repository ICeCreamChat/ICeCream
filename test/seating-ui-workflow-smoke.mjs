import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';
import sharp from 'sharp';

import { startGateway } from '../gateway/server.js';

const QUIET_LOGGER = {
    log() {},
    info() {},
    warn() {},
    error(...args) {
        console.error(...args);
    },
};

function rememberEnv(keys) {
    return new Map(keys.map(key => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
    for (const [key, value] of snapshot.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

async function assertNonBlankScreenshot(buffer, label) {
    const metadata = await sharp(buffer).metadata();
    const stats = await sharp(buffer).stats();
    assert.ok((metadata.width || 0) >= 320, `${label} screenshot width is too small`);
    assert.ok((metadata.height || 0) >= 320, `${label} screenshot height is too small`);
    assert.ok(stats.channels.slice(0, 3).some(channel => channel.stdev > 8), `${label} screenshot appears blank`);
}

async function launchSeatingTool(page, baseUrl) {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.ICeCream?.appLauncher));
    await page.locator('#apps-btn').click();
    await page.locator('.app-launcher-overlay.active').waitFor();
    await page.locator('.app-card[data-tool="seating"]').click();
    await page.locator('.tool-container.active .sp-app').waitFor({ timeout: 20000 });
}

async function seedRosterAndRequirements(page) {
    return page.evaluate(async () => {
        const launcher = (await import('/js/tools/app-launcher.js')).default;
        const planner = launcher.currentToolInstance;
        const students = Array.from({ length: 45 }, (_, index) => ({
            id: `s${String(index + 1).padStart(2, '0')}`,
            name: `学生${index + 1}`,
            gender: index % 2 === 0 ? 'M' : 'F',
            grade: 60 + (index % 35),
            height: 145 + (index % 35),
        }));
        planner.applyRosterReviewState({ students, removedIds: [] });
        planner.syncRosterEditorAfterUpdate();

        const setValue = (id, value) => {
            const element = document.getElementById(id);
            element.value = value;
            element.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setValue('sp-layout-group-size', '2');
        setValue('sp-layout-group-gap', 'normal');
        setValue('sp-layout-main-aisle', 'none');
        document.getElementById('sp-layout-groups-per-row').value = '';
        document.getElementById('sp-arrange-prompt').value = '';
        planner.updateLayoutRequirementSummary();

        return {
            students: planner.students.length,
            initialRows: planner.rows,
            initialCols: planner.cols,
            summary: document.getElementById('sp-layout-requirement-summary').textContent,
        };
    });
}

async function waitForPreview(page) {
    await page.locator('#sp-layout-preview-confirm').waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForFunction(() => {
        const launcher = window.ICeCream?.appLauncher;
        const planner = launcher?.currentToolInstance;
        return Boolean(planner?.pendingLayoutPreview?.classroomLayout);
    });
}

async function previewFacts(page) {
    return page.evaluate(() => {
        const planner = window.ICeCream.appLauncher.currentToolInstance;
        const layout = planner.pendingLayoutPreview.classroomLayout;
        const cells = layout.cells.flat();
        const groupIds = new Set(layout.groups.flat().filter(value => value !== null && value !== undefined));
        return {
            rows: layout.rows,
            cols: layout.cols,
            seats: cells.filter(cell => cell === 'seat').length,
            aisles: cells.filter(cell => cell === 'aisle').length,
            emptyCells: cells.filter(cell => cell === 'empty').length,
            groups: groupIds.size,
            verticalLocalAisles: layout.localAisles.vertical.length,
            unavailableNodes: document.querySelectorAll('.sp-seat--unavailable').length,
            seatNodes: document.querySelectorAll('.sp-grid .sp-seat:not(.sp-seat--aisle):not(.sp-seat--unavailable)').length,
            summary: document.getElementById('sp-layout-preview-summary').textContent,
            meta: document.getElementById('sp-layout-preview-meta').textContent,
        };
    });
}

async function main() {
    const host = '127.0.0.1';
    const port = Number(process.env.SEATING_SMOKE_PORT || 3191);
    const baseUrl = `http://${host}:${port}`;
    const artifactDir = process.env.SEATING_SMOKE_ARTIFACT_DIR || path.join(os.tmpdir(), 'icecream-seating-smoke');
    const envSnapshot = rememberEnv([
        'DEEPSEEK_API_BASE',
        'DEEPSEEK_API_KEY',
        'OPENAI_API_KEY',
        'TIMEFOLD_SOLVER_URL',
        'TIMEFOLD_SOLVER_TIMEOUT',
        'PORT',
        'HOST',
        'CORS_ORIGIN',
    ]);
    process.env.DEEPSEEK_API_BASE = '';
    process.env.DEEPSEEK_API_KEY = '';
    process.env.OPENAI_API_KEY = '';
    process.env.TIMEFOLD_SOLVER_URL = '';
    process.env.TIMEFOLD_SOLVER_TIMEOUT = '1';
    process.env.PORT = String(port);
    process.env.HOST = host;
    process.env.CORS_ORIGIN = `${baseUrl},http://localhost:${port}`;

    let server = null;
    let browser = null;
    let page = null;
    const pageErrors = [];
    const consoleErrors = [];

    try {
        await mkdir(artifactDir, { recursive: true });
        ({ server } = startGateway({ host, port, isDev: true, logger: QUIET_LOGGER }));
        browser = await chromium.launch({ headless: true });
        page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('console', message => {
            if (message.type() === 'error') consoleErrors.push(message.text());
        });
        await launchSeatingTool(page, baseUrl);

        const seeded = await seedRosterAndRequirements(page);
        assert.equal(seeded.students, 45);
        assert.equal(seeded.initialRows, 6);
        assert.equal(seeded.initialCols, 8);
        assert.match(seeded.summary, /2人一组/);
        assert.match(seeded.summary, /组间留距/);
        assert.match(seeded.summary, /无主过道/);

        await page.locator('#sp-generate').click();
        await waitForPreview(page);
        const firstPreview = await previewFacts(page);
        assert.deepEqual(firstPreview, {
            rows: 5,
            cols: 10,
            seats: 46,
            aisles: 0,
            emptyCells: 4,
            groups: 23,
            verticalLocalAisles: 18,
            unavailableNodes: 4,
            seatNodes: 46,
            summary: '2人一组 · 组间留距',
            meta: '5 排 · 23 组 · 46 座 · 1 个空位 · 确认后安排学生',
        });

        const previewDesktop = await page.locator('.sp-main').screenshot({
            path: path.join(artifactDir, 'seating-preview-desktop.png'),
        });
        await assertNonBlankScreenshot(previewDesktop, 'desktop preview');

        await page.locator('#sp-layout-preview-cancel').click();
        await page.locator('#sp-layout-preview-confirm').waitFor({ state: 'hidden' });
        const restored = await page.evaluate(() => {
            const planner = window.ICeCream.appLauncher.currentToolInstance;
            return { rows: planner.rows, cols: planner.cols, pending: planner.pendingLayoutPreview };
        });
        assert.deepEqual(restored, { rows: 6, cols: 8, pending: null });

        await page.locator('#sp-generate').click();
        await waitForPreview(page);
        await page.locator('#sp-layout-preview-assign').click();
        await page.locator('#sp-layout-preview-confirm').waitFor({ state: 'hidden', timeout: 30000 });
        const assigned = await page.evaluate(() => {
            const planner = window.ICeCream.appLauncher.currentToolInstance;
            return {
                assignments: planner.getCurrentAssignments().length,
                unassigned: planner.unassigned.length,
                rows: planner.rows,
                cols: planner.cols,
                pending: planner.pendingLayoutPreview,
            };
        });
        assert.deepEqual(assigned, { assignments: 45, unassigned: 0, rows: 5, cols: 10, pending: null });

        const assignedDesktop = await page.locator('.sp-main').screenshot({
            path: path.join(artifactDir, 'seating-assigned-desktop.png'),
        });
        await assertNonBlankScreenshot(assignedDesktop, 'desktop assigned');

        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#sp-generate').click();
        await waitForPreview(page);
        await page.locator('#sp-layout-preview-confirm').scrollIntoViewIfNeeded();
        const mobile = await page.evaluate(() => {
            const bar = document.getElementById('sp-layout-preview-confirm').getBoundingClientRect();
            const buttons = [...document.querySelectorAll('#sp-layout-preview-confirm button')]
                .map(button => button.getBoundingClientRect());
            const overlaps = buttons.some((first, index) => buttons.slice(index + 1).some(second => !(
                first.right <= second.left
                || second.right <= first.left
                || first.bottom <= second.top
                || second.bottom <= first.top
            )));
            return {
                viewportWidth: innerWidth,
                documentWidth: document.documentElement.scrollWidth,
                barWidth: bar.width,
                buttonsInside: buttons.every(button => button.left >= bar.left && button.right <= bar.right),
                overlaps,
                actionColumns: getComputedStyle(document.querySelector('.sp-layout-preview-actions')).gridTemplateColumns,
            };
        });
        assert.equal(mobile.documentWidth <= mobile.viewportWidth, true, JSON.stringify(mobile));
        assert.equal(mobile.barWidth <= mobile.viewportWidth, true, JSON.stringify(mobile));
        assert.equal(mobile.buttonsInside, true, JSON.stringify(mobile));
        assert.equal(mobile.overlaps, false, JSON.stringify(mobile));
        assert.doesNotMatch(mobile.actionColumns, /\s/);

        const previewMobile = await page.locator('.sp-classroom-view').screenshot({
            path: path.join(artifactDir, 'seating-preview-mobile.png'),
        });
        await assertNonBlankScreenshot(previewMobile, 'mobile preview');
        await page.locator('#sp-layout-preview-cancel').click();

        assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join(' | ')}`);
        assert.deepEqual(consoleErrors, [], `browser console errors: ${consoleErrors.join(' | ')}`);
        console.log(JSON.stringify({ ok: true, artifactDir, firstPreview, assigned, mobile }, null, 2));
    } finally {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        if (server) await new Promise(resolve => server.close(resolve));
        restoreEnv(envSnapshot);
    }
}

await main();
