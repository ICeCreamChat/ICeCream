import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import AdmZip from 'adm-zip';
import { chromium } from 'playwright-core';

const PORT = 3218;
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const events = [];
const tempRoots = [];

function log(step) {
    console.log(`[e2e] ${step}`);
}

function escapeXml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function columnName(index) {
    let n = index + 1;
    let name = '';
    while (n > 0) {
        const mod = (n - 1) % 26;
        name = String.fromCharCode(65 + mod) + name;
        n = Math.floor((n - mod) / 26);
    }
    return name;
}

function buildXlsxBuffer(rows) {
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`));
    zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`));
    zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="任课表" sheetId="1" r:id="rId1"/></sheets>
</workbook>`));
    zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`));

    const sheetRows = rows.map((row, rowIndex) => {
        const cells = row.map((value, colIndex) => {
            const ref = `${columnName(colIndex)}${rowIndex + 1}`;
            return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
        }).join('');
        return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetRows}</sheetData>
</worksheet>`));
    return zip.toBuffer();
}

function sampleRows() {
    return [
        ['班级', '科目', '教师', '周课时', '连堂', '专用教室'],
        ['一班', '语文', '张老师', '3', '1', ''],
        ['一班', '数学', '李老师', '3', '1', ''],
        ['一班', '体育', '王老师', '2', '1', '操场'],
        ['二班', '语文', '张老师', '3', '1', ''],
        ['二班', '数学', '李老师', '3', '1', ''],
        ['二班', '体育', '王老师', '2', '1', '操场'],
    ];
}

function attachPageAudit(page, label) {
    page.on('console', (msg) => {
        if (msg.type() === 'error') {
            events.push({ type: 'console', label, text: msg.text(), location: msg.location() });
        }
    });
    page.on('pageerror', (err) => events.push({ type: 'pageerror', label, text: String(err) }));
    page.on('requestfailed', (req) => {
        events.push({ type: 'requestfailed', label, url: req.url(), failure: req.failure()?.errorText });
    });
    page.on('response', (res) => {
        if (res.status() >= 500) events.push({ type: 'http', label, status: res.status(), url: res.url() });
    });
}

function isRelevantEvent(event) {
    const text = `${event.text || ''} ${event.url || ''} ${event.failure || ''}`;
    return !/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|unpkg|cdnjs|katex|cropper|favicon|Manim 服务未启动/i.test(text);
}

async function waitForServer(proc) {
    const deadline = Date.now() + 45000;
    let lastError = null;
    while (Date.now() < deadline) {
        if (proc.exitCode !== null) throw new Error(`gateway exited early with code ${proc.exitCode}`);
        try {
            const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) });
            if (res.ok) return;
            lastError = new Error(`health ${res.status}`);
        } catch (error) {
            lastError = error;
        }
        await delay(500);
    }
    throw new Error(`gateway did not become healthy: ${lastError?.message || lastError}`);
}

async function startGateway() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttv2-e2e-data-'));
    tempRoots.push(dataDir);
    const proc = spawn(process.execPath, ['gateway/server.js'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            PORT: String(PORT),
            HOST,
            NODE_ENV: 'development',
            TIMETABLE_V2_ENABLED: 'true',
            TIMETABLE_V2_DATA_DIR: dataDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    await waitForServer(proc);
    return { proc, getLogs: () => ({ stdout, stderr }) };
}

async function stopGateway(proc) {
    if (!proc || proc.exitCode !== null) return;
    proc.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => proc.once('exit', resolve)), delay(3000)]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
}

async function enterTimetable(page) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.locator('#apps-btn').click();
    await page.locator('.app-card[data-tool="timetable"]').click();
    await page.locator('.ttv2-workbench').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForLoadState('networkidle').catch(() => {});
}

async function clickStep(page, step) {
    await page.locator(`.ttv2-stepnav__item[data-step="${step}"]`).click();
    await page.locator(`.ttv2-view--${step}`).waitFor({ state: 'visible', timeout: 10000 });
}

async function noHorizontalOverflow(page, label) {
    const overflow = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
    }));
    assert.ok(
        overflow.docScrollWidth <= overflow.innerWidth + 2,
        `${label} has horizontal overflow: ${JSON.stringify(overflow)}`,
    );
}

async function assertCanvasNonBlank(page, selector, label) {
    const canvases = await page.locator(selector).evaluateAll((nodes) => nodes.map((canvas) => {
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const ctx = copy.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
        let nonTransparent = 0;
        let colored = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] !== 0) nonTransparent += 1;
            if (data[i + 3] !== 0 && (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255)) {
                colored += 1;
            }
        }
        return { width: copy.width, height: copy.height, nonTransparent, colored };
    }));
    const result = canvases.sort((a, b) => b.nonTransparent - a.nonTransparent)[0] || {
        width: 0,
        height: 0,
        nonTransparent: 0,
        colored: 0,
    };
    assert.ok(result.width > 300 && result.height > 250, `${label} canvas too small: ${JSON.stringify(result)}`);
    assert.ok(result.nonTransparent > 5000 && result.colored > 1000, `${label} canvas blank: ${JSON.stringify(result)}`);
}

async function runDesktop(browser) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, acceptDownloads: true });
    const page = await context.newPage();
    attachPageAudit(page, 'desktop');

    log('desktop enter');
    await enterTimetable(page);
    await page.locator('.ttv2-shell__nav').waitFor({ state: 'visible' });
    await page.locator('.ttv2-shell__aside').waitFor({ state: 'visible' });
    const labels = await page.locator('.ttv2-stepnav__label').evaluateAll((nodes) => nodes.map((n) => n.textContent.trim()));
    assert.deepEqual(labels, ['数据准备', '规则输入', '规则审核', '求解进度', '结果诊断', '手动调整', '发布导出']);

    log('xlsx import');
    const sourceSelect = page.locator('.ttv2-view--data-prep select').first();
    const options = await sourceSelect.evaluate((el) => [...el.options].map((o) => ({
        value: o.value,
        label: o.textContent.trim(),
    })));
    assert.ok(options.some((o) => o.value === 'xlsx' && /Excel|xlsx/i.test(o.label)), `missing xlsx option: ${JSON.stringify(options)}`);
    await sourceSelect.selectOption('xlsx');
    const xlsxState = await page.evaluate(() => {
        const view = document.querySelector('.ttv2-view--data-prep');
        const input = view.querySelector('input[type="file"]');
        const textarea = view.querySelector('textarea');
        return { accept: input?.accept, disabled: textarea?.disabled, ariaDisabled: textarea?.getAttribute('aria-disabled') };
    });
    assert.match(xlsxState.accept || '', /\.xlsx/);
    assert.equal(xlsxState.disabled, true);
    await page.locator('.ttv2-view--data-prep input[type="file"]').setInputFiles({
        name: '教学计划.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: buildXlsxBuffer(sampleRows()),
    });
    const importResponsePromise = page.waitForResponse((r) => r.url().includes('/api/tools/timetable-v2/import') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '生成导入预览' }).click();
    const importResponse = await importResponsePromise;
    assert.equal(importResponse.status(), 200);
    const importJson = await importResponse.json();
    assert.equal(importJson.success, true);
    assert.ok(importJson.data.project.classes.length >= 2);
    assert.ok(importJson.data.project.activityPlans.length >= 4);
    await page.getByText(/Excel 导入预览已生成/).waitFor({ timeout: 10000 });

    log('save project');
    const projectResponsePromise = page.waitForResponse((r) => r.url().includes('/api/tools/timetable-v2/project') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '保存为项目' }).click();
    const projectResponse = await projectResponsePromise;
    assert.equal(projectResponse.status(), 200);
    await page.getByText(/项目已保存/).waitFor({ timeout: 10000 });

    log('rules');
    await clickStep(page, 'rule-input');
    await page.getByRole('textbox', { name: '自然语言约束（原文交后端解析）' }).fill('张老师周一全天不排课；语文尽量上午');
    await page.getByRole('button', { name: '解析为草稿' }).click();
    await page.getByText(/已加入待确认草稿/).waitFor({ timeout: 10000 });
    await clickStep(page, 'rule-review');
    await page.locator('.ttv2-rule').first().waitFor({ state: 'visible', timeout: 10000 });
    const rulesResponsePromise = page.waitForResponse((r) => r.url().includes('/api/tools/timetable-v2/rules') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '确认写入全部草稿' }).click();
    const rulesResponse = await rulesResponsePromise;
    assert.equal(rulesResponse.status(), 200);
    const rulesJson = await rulesResponse.json();
    assert.equal(rulesJson.success, true);
    assert.ok((rulesJson.data.project.constraints || []).length >= 1);

    log('solve');
    await clickStep(page, 'solve-progress');
    const solveResponsePromise = page.waitForResponse((r) => r.url().includes('/api/tools/timetable-v2/schedule/run') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '开始求解' }).click();
    const solveResponse = await solveResponsePromise;
    assert.equal(solveResponse.status(), 200);
    const solveJson = await solveResponse.json();
    assert.equal(solveJson.success, true);
    const solution = solveJson.data;
    assert.ok((solution.placements || []).length > 0);
    assert.equal((solution.hardConflicts || []).length, 0);
    assert.equal((solution.unplaced || []).length, 0);

    log('diagnostics canvas');
    await clickStep(page, 'result-diagnostics');
    await page.locator('.ttv2-result__grid-wrap canvas').first().waitFor({ state: 'visible', timeout: 10000 });
    await assertCanvasNonBlank(page, '.ttv2-result__grid-wrap canvas', 'result diagnostics');

    log('manual adjustment intent');
    await clickStep(page, 'manual-adjust');
    await page.locator('.ttv2-adjust__grid-wrap canvas').first().waitFor({ state: 'visible', timeout: 10000 });
    const firstPlacement = solution.placements[0];
    const HEADER_W = 64;
    const HEADER_H = 36;
    const CELL_W = 120;
    const CELL_H = 56;
    const GAP = 2;
    const cellPoint = (day, period) => ({
        x: HEADER_W + (day - 1) * (CELL_W + GAP) + GAP + CELL_W / 2,
        y: HEADER_H + (period - 1) * (CELL_H + GAP) + GAP + CELL_H / 2,
    });
    const src = cellPoint(firstPlacement.day, firstPlacement.period);
    const tgt = cellPoint(firstPlacement.day === 1 ? 2 : 1, firstPlacement.period);
    const box = await page.locator('.ttv2-adjust__grid-wrap canvas').first().boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + src.x, box.y + src.y);
    await page.mouse.click(box.x + tgt.x, box.y + tgt.y);
    const adjustResponsePromise = page.waitForResponse((r) => r.url().includes('/api/tools/timetable-v2/schedule/run') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '提交移动' }).click();
    const adjustResponse = await adjustResponsePromise;
    assert.equal(adjustResponse.status(), 200);
    const adjustJson = await adjustResponse.json();
    assert.equal(adjustJson.success, true);
    assert.ok((adjustJson.data.placements || []).length > 0);
    await page.getByText(/调整已提交/).waitFor({ timeout: 10000 });

    log('publish/export');
    await clickStep(page, 'publish-export');
    const publishResponsePromise = page.waitForResponse((r) => r.url().includes('/api/tools/timetable-v2/schedule/publish') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '发布课表' }).click();
    const publishResponse = await publishResponsePromise;
    assert.equal(publishResponse.status(), 200);
    const publishJson = await publishResponse.json();
    assert.equal(publishJson.success, true);
    assert.ok(publishJson.data.published || publishJson.data.publishedSnapshot);

    const exportResponsePromise = page.waitForResponse((r) => r.url().includes('/api/tools/timetable-v2/export') && r.request().method() === 'POST');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出课表' }).click();
    const [exportResponse, download] = await Promise.all([exportResponsePromise, downloadPromise]);
    assert.equal(exportResponse.status(), 200);
    const suggested = download.suggestedFilename();
    assert.match(suggested, /\.xlsx$/i);
    const downloadPath = await download.path();
    assert.ok(downloadPath && fs.statSync(downloadPath).size > 500);

    await noHorizontalOverflow(page, 'desktop');
    await context.close();
    return { placements: solution.placements.length, filename: suggested };
}

async function runMobile(browser) {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    attachPageAudit(page, 'mobile');

    log('mobile enter');
    await enterTimetable(page);
    await page.locator('.ttv2-shell--narrow').waitFor({ state: 'visible', timeout: 15000 });
    await noHorizontalOverflow(page, 'mobile initial');
    await page.locator('.ttv2-view--data-prep').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#tool-theme-toggle').click();
    await page.waitForFunction(() => document.body.classList.contains('light-mode'), null, { timeout: 5000 });
    await page.locator('.ttv2-workbench').waitFor({ state: 'visible' });
    await noHorizontalOverflow(page, 'mobile light');
    await context.close();
}

let gateway;
let browser;
try {
    gateway = await startGateway();
    browser = await chromium.launch({ headless: true });
    const desktop = await runDesktop(browser);
    await runMobile(browser);
    const relevantEvents = events.filter(isRelevantEvent);
    assert.deepEqual(relevantEvents, [], `browser audit events: ${JSON.stringify(relevantEvents, null, 2)}`);
    console.log(JSON.stringify({ ok: true, base: BASE, desktop, eventCount: events.length }, null, 2));
} catch (error) {
    console.error(error && error.stack || error);
    if (gateway) console.error('gateway logs:', JSON.stringify(gateway.getLogs(), null, 2).slice(0, 20000));
    process.exitCode = 1;
} finally {
    if (browser) await browser.close().catch(() => {});
    if (gateway) await stopGateway(gateway.proc).catch(() => {});
    for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
}
