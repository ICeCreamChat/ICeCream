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
        const students = Array.from({ length: 60 }, (_, index) => ({
            id: `s${String(index + 1).padStart(2, '0')}`,
            name: `学生${index + 1}`,
            gender: index % 2 === 0 ? 'M' : 'F',
            grade: 60 + (index % 35),
            height: 145 + (index % 35),
        }));
        planner.applyRosterReviewState({ students, removedIds: [] });
        planner.syncRosterEditorAfterUpdate();
        document.getElementById('sp-arrange-prompt').value = '两人一组，每组之间设置可通行过道。';
        planner.updateLayoutRequirementSummary();
        return {
            students: planner.students.length,
            initialRows: planner.rows,
            initialCols: planner.cols,
            summary: document.getElementById('sp-layout-requirement-summary').textContent,
        };
    });
}

async function waitForRecognition(page) {
    await page.waitForFunction(() => {
        const planner = window.ICeCream?.appLauncher?.currentToolInstance;
        return Boolean(planner?.recognizedArrangement?.arrangementSpec)
            && planner.arrangementRecognitionStale === false;
    });
}

async function waitForPreview(page) {
    await page.locator('#sp-layout-preview-confirm').waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForFunction(() => {
        const planner = window.ICeCream?.appLauncher?.currentToolInstance;
        return Boolean(planner?.pendingLayoutPreview?.classroomLayout);
    });
}

async function previewFacts(page) {
    return page.evaluate(() => {
        const planner = window.ICeCream.appLauncher.currentToolInstance;
        const layout = planner.pendingLayoutPreview.classroomLayout;
        const cells = layout.cells.flat();
        const groupIds = new Set(layout.groups.flat().filter(value => value !== null && value !== undefined));
        const aisleNode = document.querySelector('.sp-seat--aisle');
        const seatNode = document.querySelector('.sp-grid .sp-seat:not(.sp-seat--aisle):not(.sp-seat--unavailable)');
        return {
            rows: layout.rows,
            cols: layout.cols,
            seats: cells.filter(cell => cell === 'seat').length,
            aisles: cells.filter(cell => cell === 'aisle').length,
            emptyCells: cells.filter(cell => cell === 'empty').length,
            groups: groupIds.size,
            unavailableNodes: document.querySelectorAll('.sp-seat--unavailable').length,
            seatNodes: document.querySelectorAll('.sp-grid .sp-seat:not(.sp-seat--aisle):not(.sp-seat--unavailable)').length,
            summary: document.getElementById('sp-layout-preview-summary').textContent,
            meta: document.getElementById('sp-layout-preview-meta').textContent,
            aisleWidth: aisleNode?.getBoundingClientRect().width || 0,
            seatWidth: seatNode?.getBoundingClientRect().width || 0,
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
            if (message.type() !== 'error') return;
            const location = message.location();
            const source = location.url
                ? ` (${location.url}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0})`
                : '';
            consoleErrors.push(`${message.text()}${source}`);
        });
        await launchSeatingTool(page, baseUrl);

        const seeded = await seedRosterAndRequirements(page);
        assert.deepEqual(seeded, {
            students: 60,
            initialRows: 6,
            initialCols: 8,
            summary: '等待 AI 识别自然语言排座要求',
        });

        await page.locator('#sp-parse-arrangement').click();
        await waitForRecognition(page);
        const recognized = await page.evaluate(() => {
            const planner = window.ICeCream.appLauncher.currentToolInstance;
            return {
                rows: planner.rows,
                cols: planner.cols,
                pending: planner.pendingLayoutPreview,
                groupSize: planner.recognizedArrangement.arrangementSpec.groupSize,
                betweenGroups: planner.recognizedArrangement.arrangementSpec.circulation.betweenGroups,
                generateDisabled: document.getElementById('sp-generate').disabled,
                factText: document.getElementById('sp-arrangement-rule-facts').textContent,
            };
        });
        assert.deepEqual(recognized, {
            rows: 6,
            cols: 8,
            pending: null,
            groupSize: 2,
            betweenGroups: 'walkway',
            generateDisabled: false,
            factText: '每组人数2 人组间形式可通行过道排间形式不留间距主过道无主过道',
        });

        await page.locator('#sp-arrange-prompt').fill('两人一组，每组之间设置可通行过道，并增加中央竖向主过道。');
        await page.waitForFunction(() => window.ICeCream.appLauncher.currentToolInstance.arrangementRecognitionStale === true);
        assert.equal(await page.locator('#sp-generate').isDisabled(), true);
        assert.match(await page.locator('#sp-layout-requirement-summary').textContent(), /要求已修改，请重新识别/);
        await page.locator('#sp-arrange-prompt').fill('两人一组，每组之间设置可通行过道。');
        await page.waitForFunction(() => window.ICeCream.appLauncher.currentToolInstance.arrangementRecognitionStale === false);

        assert.equal(await page.locator('#sp-arrangement-diagram svg').count(), 1);
        assert.ok(await page.locator('#sp-arrangement-diagram .sp-arrangement-svg__walkway-label').count() > 0);
        assert.equal(await page.locator('.sp-arrangement-legend').count(), 1);
        await page.locator('#sp-arrangement-open-editor').click();
        await page.locator('#sp-arrangement-editor.is-open').waitFor();
        assert.equal(await page.locator('#sp-arrangement-editor-diagram svg').count(), 1);
        assert.ok(await page.locator('#sp-arrangement-editor-diagram [data-diagram-target="betweenGroups"]').count() > 0);
        assert.equal(await page.locator('.sp-arrangement-editor__body > aside').count(), 0);
        assert.equal(await page.locator('#sp-arrangement-editor-diagram .sp-arrangement-svg__desk').count(), 12);
        await page.locator('[data-target="betweenRows"][data-arrangement-mode="gap"]').click();

        const editorDesktop = await page.locator('.sp-arrangement-editor__dialog').screenshot({
            path: path.join(artifactDir, 'seating-arrangement-editor-desktop.png'),
        });
        await assertNonBlankScreenshot(editorDesktop, 'arrangement editor');
        await page.locator('#sp-arrangement-apply').click();
        await page.locator('#sp-arrangement-editor.is-open').waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => (
            window.ICeCream.appLauncher.currentToolInstance.recognizedArrangement.arrangementSpec.circulation.betweenRows
        )), 'gap');

        await page.locator('#sp-generate').click();
        await waitForPreview(page);
        await page.waitForFunction(() => {
            const panel = document.getElementById('sp-layout-preview-confirm');
            const rect = panel?.getBoundingClientRect();
            return Boolean(rect) && rect.top >= 0 && rect.bottom <= innerHeight;
        });
        const firstPreview = await previewFacts(page);
        assert.deepEqual({
            rows: firstPreview.rows,
            cols: firstPreview.cols,
            seats: firstPreview.seats,
            aisles: firstPreview.aisles,
            emptyCells: firstPreview.emptyCells,
            groups: firstPreview.groups,
            unavailableNodes: firstPreview.unavailableNodes,
            seatNodes: firstPreview.seatNodes,
            summary: firstPreview.summary,
            meta: firstPreview.meta,
        }, {
            rows: 5,
            cols: 17,
            seats: 60,
            aisles: 25,
            emptyCells: 0,
            groups: 30,
            unavailableNodes: 0,
            seatNodes: 60,
            summary: '2人一组 · 组间可通行过道 · 排间留普通间距',
            meta: '5 排 · 30 组 · 60 座 · 确认后安排学生',
        });
        assert.ok(firstPreview.aisleWidth > 0 && firstPreview.aisleWidth < firstPreview.seatWidth * 0.55, JSON.stringify(firstPreview));

        await page.waitForTimeout(3600);
        await page.locator('.sp-classroom-view').evaluate(element => { element.scrollTop = 0; });
        const previewDesktop = await page.screenshot({
            path: path.join(artifactDir, 'seating-preview-desktop.png'),
        });
        await assertNonBlankScreenshot(previewDesktop, 'desktop preview');

        await page.locator('#sp-layout-preview-edit').click();
        await page.locator('#sp-arrangement-editor.is-open').waitFor();
        await page.locator('#sp-arrangement-editor-cancel').click();
        const restored = await page.evaluate(() => {
            const planner = window.ICeCream.appLauncher.currentToolInstance;
            return { rows: planner.rows, cols: planner.cols, pending: planner.pendingLayoutPreview };
        });
        assert.deepEqual(restored, { rows: 6, cols: 8, pending: null });

        await page.locator('#sp-generate').click();
        await waitForPreview(page);
        await page.locator('#sp-layout-preview-cancel').click();
        const cancelled = await page.evaluate(() => {
            const planner = window.ICeCream.appLauncher.currentToolInstance;
            return { rows: planner.rows, cols: planner.cols, recognized: Boolean(planner.recognizedArrangement) };
        });
        assert.deepEqual(cancelled, { rows: 6, cols: 8, recognized: true });

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
        assert.deepEqual(assigned, { assignments: 60, unassigned: 0, rows: 5, cols: 17, pending: null });

        await page.waitForTimeout(3600);
        await page.locator('.sp-classroom-view').evaluate(element => { element.scrollTop = 0; });
        const assignedDesktop = await page.screenshot({
            path: path.join(artifactDir, 'seating-assigned-desktop.png'),
        });
        await assertNonBlankScreenshot(assignedDesktop, 'desktop assigned');

        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#sp-arrangement-open-editor').click();
        await page.locator('#sp-arrangement-editor.is-open').waitFor();
        const mobileEditor = await page.evaluate(() => {
            const dialog = document.querySelector('.sp-arrangement-editor__dialog').getBoundingClientRect();
            const buttons = [...document.querySelectorAll('.sp-arrangement-editor__controls button')]
                .map(button => button.getBoundingClientRect());
            const overflow = buttons.some(button => button.left < dialog.left || button.right > dialog.right);
            return {
                viewportWidth: innerWidth,
                documentWidth: document.documentElement.scrollWidth,
                dialogWidth: dialog.width,
                overflow,
            };
        });
        assert.equal(mobileEditor.documentWidth <= mobileEditor.viewportWidth, true, JSON.stringify(mobileEditor));
        assert.equal(mobileEditor.dialogWidth <= mobileEditor.viewportWidth, true, JSON.stringify(mobileEditor));
        assert.equal(mobileEditor.overflow, false, JSON.stringify(mobileEditor));
        const crossButton = page.locator('[data-target="mainAisle"][data-arrangement-mode="cross"]');
        await crossButton.scrollIntoViewIfNeeded();
        const mobileControlVisibility = await page.evaluate(() => {
            const button = document.querySelector('[data-target="mainAisle"][data-arrangement-mode="cross"]').getBoundingClientRect();
            const footer = document.querySelector('.sp-arrangement-editor__footer').getBoundingClientRect();
            const controls = document.querySelector('.sp-arrangement-editor__controls').getBoundingClientRect();
            return {
                buttonTop: button.top,
                buttonBottom: button.bottom,
                controlsTop: controls.top,
                controlsBottom: controls.bottom,
                footerTop: footer.top,
            };
        });
        assert.ok(mobileControlVisibility.buttonTop >= mobileControlVisibility.controlsTop, JSON.stringify(mobileControlVisibility));
        assert.ok(mobileControlVisibility.buttonBottom <= mobileControlVisibility.controlsBottom, JSON.stringify(mobileControlVisibility));
        assert.ok(mobileControlVisibility.buttonBottom <= mobileControlVisibility.footerTop, JSON.stringify(mobileControlVisibility));
        const editorMobile = await page.locator('.sp-arrangement-editor__dialog').screenshot({
            path: path.join(artifactDir, 'seating-arrangement-editor-mobile.png'),
        });
        await assertNonBlankScreenshot(editorMobile, 'mobile arrangement editor');
        await page.locator('#sp-arrangement-editor-cancel').click();
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
        console.log(JSON.stringify({ ok: true, artifactDir, recognized, firstPreview, assigned, mobileEditor, mobile }, null, 2));
    } finally {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        if (server) await new Promise(resolve => server.close(resolve));
        restoreEnv(envSnapshot);
    }
}

await main();
