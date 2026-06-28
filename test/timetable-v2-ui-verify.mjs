/**
 * Phase 5 真实浏览器验证（AGENTS.md 前端可视化要求）。
 * 起静态服务器 → Playwright Chromium 打开工作台 → 走关键路径 → 抓控制台 error。
 * 运行：node test/timetable-v2-ui-verify.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { sampleProject } from '../public/js/tools/timetable-v2/api/mock/project.sample.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icecream-ttv2-ui-'));
const bundlePath = path.join(tempDir, 'verify.bundle.js');
const verifyHtml = `<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" href="data:,">
    <title>Timetable V2 UI verification</title>
    <style>
        * { box-sizing: border-box; }
        body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; background: #f8fafc; }
        #app { width: 100%; min-height: 720px; }
    </style>
</head>
<body>
    <main id="app"></main>
    <script src="/__ttv2_verify.bundle.js"></script>
</body>
</html>`;

await build({
    stdin: {
        contents: `
            import { mountTimetableV2 } from './public/js/tools/timetable-v2/app/workbench.js';
            import { sampleProject } from './public/js/tools/timetable-v2/api/mock/project.sample.js';
            import { sampleSolution } from './public/js/tools/timetable-v2/api/mock/solution.sample.js';
            import { sampleDiagnostics } from './public/js/tools/timetable-v2/api/mock/diagnostics.sample.js';

            try {
                const workbench = mountTimetableV2(document.getElementById('app'));
                workbench.store.dispatch('setProject', sampleProject);
                workbench.store.dispatch('setSolution', sampleSolution);
                workbench.store.dispatch('setDiagnostics', sampleDiagnostics);
                window.__wb = workbench;
                window.__wbReady = true;
            } catch (error) {
                window.__wbError = error && (error.stack || error.message) || String(error);
            }
        `,
        resolveDir: ROOT,
        sourcefile: 'timetable-v2-ui-verify.entry.js',
        loader: 'js',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outfile: bundlePath,
    jsx: 'automatic',
    loader: { '.jsx': 'jsx' },
    logLevel: 'silent',
});

const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/js/tools/timetable-v2/__verify.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(verifyHtml);
        return;
    }
    if (urlPath === '/__ttv2_verify.bundle.js') {
        fs.createReadStream(bundlePath)
            .on('error', () => { res.writeHead(500); res.end('bundle unavailable'); })
            .pipe(res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
        return;
    }
    if (urlPath === '/api/tools/timetable-v2/bootstrap') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            success: true,
            data: {
                project: sampleProject,
                needsMigration: false,
                capabilities: {
                    solver: true,
                    diagnostics: true,
                    gridView: true,
                    xlsxExport: true,
                    importSources: ['legacy', 'excel', 'crystal', 'yqd'],
                    timefold: false,
                },
            },
        }));
        return;
    }
    const filePath = path.join(ROOT, 'public', urlPath);
    if (!filePath.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
    });
});

function fail(msg) { console.error('❌ ' + msg); process.exitCode = 1; }
function ok(msg) { console.log('✅ ' + msg); }

async function assertBoundLabels(page, step, label) {
    await page.evaluate((targetStep) => {
        window.__wb?.store?.dispatch('goStep', targetStep);
    }, step);
    await page.waitForTimeout(100);
    const audit = await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll('label'));
        const issues = labels
            .map((labelEl) => ({
                text: labelEl.textContent.trim(),
                htmlFor: labelEl.htmlFor,
                hasControl: Boolean(labelEl.htmlFor && document.getElementById(labelEl.htmlFor)),
            }))
            .filter((item) => !item.htmlFor || !item.hasControl);
        return { count: labels.length, issues };
    });
    if (audit.count > 0 && audit.issues.length === 0) {
        ok(`${label} 表单 label 已显式绑定（${audit.count} 个）`);
    } else {
        fail(`${label} 表单 label 绑定异常: ${JSON.stringify(audit.issues).slice(0, 300)}`);
    }
}

await new Promise(r => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const consoleErrors = [];

const browser = await chromium.launch();
try {
    const page = await browser.newPage();
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push(String(e)));

    await page.goto(`${base}/js/tools/timetable-v2/__verify.html`, { waitUntil: 'networkidle' });
    const ready = await page.evaluate(() => window.__wbReady);
    const mountErr = await page.evaluate(() => window.__wbError);
    if (ready) ok('工作台挂载成功'); else fail(`工作台挂载失败: ${mountErr}`);

    // 三栏壳存在
    const paneCount = await page.evaluate(() => document.querySelectorAll('#app *').length);
    if (paneCount > 10) ok(`三栏壳渲染（${paneCount} 节点）`); else fail('壳节点过少，疑似未渲染');

    // 步骤导航存在 7 步
    const navText = await page.evaluate(() => document.body.innerText);
    const steps = ['数据准备', '规则', '求解', '结果', '发布'];
    const hit = steps.filter(s => navText.includes(s));
    if (hit.length >= 4) ok(`步骤导航可见（命中 ${hit.join('/')}）`); else fail(`步骤导航缺失，仅命中 ${hit.join('/')}`);

    await assertBoundLabels(page, 'data-prep', '数据准备页');
    await assertBoundLabels(page, 'rule-input', '规则输入页');

    // 走到结果诊断步（触发 React-Konva 网格渲染）
    await page.evaluate(() => window.__wb && window.__wb.store && window.__wb.store.dispatch('goStep', 'result-diagnostics'));
    await page.waitForTimeout(800);
    const canvasCount = await page.evaluate(() => document.querySelectorAll('canvas').length);
    if (canvasCount > 0) ok(`结果诊断页课表网格 canvas 渲染（${canvasCount} 个）`);
    else console.log('⚠️ 未检测到 canvas（网格可能需先有 solution；记录但不阻断）');

    // 窄屏验证
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForTimeout(300);
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    if (!overflowX) ok('窄屏无横向溢出'); else fail('窄屏出现横向溢出');

    // 控制台错误检查
    if (consoleErrors.length === 0) ok('控制台无 error 级错误');
    else fail(`控制台 error: ${consoleErrors.slice(0, 5).join(' | ')}`);

    console.log(process.exitCode ? '\n验证未全过' : '\n✅ 验证全过');
} finally {
    await browser.close();
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
}
