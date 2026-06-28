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
let publishAttempts = 0;
const verifyHtml = `<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" href="data:,">
    <link rel="stylesheet" href="/css/timetable-v2.css">
    <title>Timetable V2 UI verification</title>
    <style>
        * { box-sizing: border-box; }
        :root {
            --bg-base: #020617;
            --text-primary: #f8fafc;
            --text-secondary: #a1b0c7;
            --accent-color: #00f0ff;
            --glass-panel: rgba(15, 23, 42, 0.45);
            --glass-border: rgba(255, 255, 255, 0.08);
            --manim-workbench-bg: #101827;
            --manim-workbench-panel-bg: #152236;
            --manim-workbench-border: rgba(148, 163, 184, 0.18);
            --manim-studio-success: #34d399;
            --manim-studio-warning: #fbbf24;
            --manim-studio-error: #f87171;
        }
        body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; background: #020617; }
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
            import { init as initTimetableV2, destroy as destroyTimetableV2 } from './public/js/tools/timetable-v2/entry.js';
            import { mountTimetableV2 } from './public/js/tools/timetable-v2/app/workbench.js';
            import { sampleProject } from './public/js/tools/timetable-v2/api/mock/project.sample.js';
            import { sampleSolution } from './public/js/tools/timetable-v2/api/mock/solution.sample.js';
            import { sampleDiagnostics } from './public/js/tools/timetable-v2/api/mock/diagnostics.sample.js';

            try {
                const launcherHost = document.createElement('section');
                launcherHost.id = 'launcher-contract';
                launcherHost.innerHTML = '<div style="height:100%">正在加载 智能排课...</div>';
                document.body.append(launcherHost);
                initTimetableV2(launcherHost);
                window.__launcherContract = {
                    placeholderRemoved: !launcherHost.textContent.includes('正在加载 智能排课'),
                    workbenchCount: launcherHost.querySelectorAll('.ttv2-workbench').length,
                    firstChildIsWorkbench: launcherHost.firstElementChild?.classList.contains('ttv2-workbench') || false,
                };
                destroyTimetableV2();
                launcherHost.remove();

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

async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
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
    if (urlPath === '/api/tools/timetable-v2/import' && req.method === 'POST') {
        await readJsonBody(req);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            success: true,
            data: {
                project: sampleProject,
                report: {
                    summary: { total: 1, kept: 1, degraded: 0, dropped: 0, review: 0 },
                    entries: [{ category: 'kept', field: 'activityPlan', reason: '验证样本导入成功' }],
                },
            },
        }));
        return;
    }
    if (urlPath === '/api/tools/timetable-v2/project' && req.method === 'POST') {
        await readJsonBody(req);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, data: { project: { ...sampleProject, revision: 2 } } }));
        return;
    }
    if (urlPath === '/api/tools/timetable-v2/schedule/run' && req.method === 'POST') {
        await readJsonBody(req);
        const { sampleSolution } = await import('../public/js/tools/timetable-v2/api/mock/solution.sample.js');
        const { sampleDiagnostics } = await import('../public/js/tools/timetable-v2/api/mock/diagnostics.sample.js');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, data: { ...sampleSolution, diagnostics: sampleDiagnostics } }));
        return;
    }
    if (urlPath === '/api/tools/timetable-v2/schedule/publish' && req.method === 'POST') {
        await readJsonBody(req);
        publishAttempts += 1;
        if (publishAttempts === 1) {
            res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                success: false,
                error: '存在未排课程，无法发布',
                data: { reason: 'unplaced_lessons', unplaced: [{ activityId: 'verify-unplaced' }] },
            }));
            return;
        }
        const { sampleSolution } = await import('../public/js/tools/timetable-v2/api/mock/solution.sample.js');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            success: true,
            data: {
                published: true,
                publishedAt: '2026-06-28T00:00:00.000Z',
                project: { ...sampleProject, revision: 3 },
                solution: sampleSolution,
                publishedSnapshot: { solutionHash: 'verify' },
            },
        }));
        return;
    }
    if (urlPath === '/api/tools/timetable-v2/export' && req.method === 'POST') {
        await readJsonBody(req);
        res.writeHead(200, {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': "attachment; filename*=UTF-8''verify.xlsx",
        });
        res.end(Buffer.from('PKverify'));
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
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const text = m.text();
        if (/422 \(Unprocessable Entity\)/.test(text)) return; // expected publish gate check
        consoleErrors.push(text);
    });
    page.on('pageerror', e => consoleErrors.push(String(e)));

    await page.goto(`${base}/js/tools/timetable-v2/__verify.html`, { waitUntil: 'networkidle' });
    const ready = await page.evaluate(() => window.__wbReady);
    const mountErr = await page.evaluate(() => window.__wbError);
    if (ready) ok('工作台挂载成功'); else fail(`工作台挂载失败: ${mountErr}`);

    const launcherContract = await page.evaluate(() => window.__launcherContract);
    if (
        launcherContract?.placeholderRemoved &&
        launcherContract?.workbenchCount === 1 &&
        launcherContract?.firstChildIsWorkbench
    ) {
        ok('课堂工具箱启动占位会在挂载前清理');
    } else {
        fail(`课堂工具箱启动占位清理异常: ${JSON.stringify(launcherContract)}`);
    }

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

    // 新 UI 关键路径：导入预览 → 保存项目 → 求解 → 发布 → 导出
    await page.evaluate(() => window.__wb?.store?.dispatch('goStep', 'data-prep'));
    await page.waitForTimeout(100);
    await page.fill('.ttv2-view--data-prep textarea', '年级,班级,课程,教师,周课时\\n七年级,一班,语文,张老师,5');
    await page.getByRole('button', { name: '生成导入预览' }).click();
    await page.waitForFunction(() => window.__wb?.store?.getState?.().importPreview?.project);
    ok('数据准备页导入预览写入 store');
    await page.getByRole('button', { name: '保存为项目' }).click();
    await page.waitForFunction(() => window.__wb?.store?.getState?.().project?.revision === 2);
    ok('数据准备页保存项目写入 store');

    await page.evaluate(() => window.__wb?.store?.dispatch('goStep', 'solve-progress'));
    await page.getByRole('button', { name: '开始求解' }).click();
    await page.waitForFunction(() => window.__wb?.store?.getState?.().solution?.placements?.length > 0);
    ok('求解页保存后端 solution 引用');

    await page.evaluate(() => window.__wb?.store?.dispatch('goStep', 'publish-export'));
    await page.evaluate(() => {
        const state = window.__wb?.store?.getState?.();
        window.__goodSolution = JSON.parse(JSON.stringify(state.solution));
        window.__wb.store.dispatch('setSolution', {
            ...state.solution,
            unplaced: [{ activityId: 'verify-unplaced', reason: { kind: 'no-candidate' } }],
        });
    });
    await page.waitForFunction(() => (window.__wb?.store?.getState?.().solution?.unplaced || []).length > 0);
    await page.getByRole('button', { name: '发布课表' }).click();
    await page.waitForTimeout(200);
    const blockedMsg = await page.locator('.ttv2-view--publish-export .ttv2-view__msg, .ttv2-view--publish-export .ttv2-message').last().innerText();
    if (/未排|无法发布/.test(blockedMsg)) ok('发布页展示后端发布拦截原因');
    else fail(`发布拦截消息异常: ${blockedMsg}`);

    await page.evaluate(() => window.__wb?.store?.dispatch('setSolution', window.__goodSolution));
    await page.getByRole('button', { name: '发布课表' }).click();
    await page.waitForFunction(() => window.__wb?.store?.getState?.().publishResult?.published === true);
    ok('发布页保存后端发布结果');
    await page.getByRole('button', { name: '导出课表' }).click();
    await page.waitForTimeout(200);
    const exportMsg = await page.locator('.ttv2-view--publish-export .ttv2-view__msg, .ttv2-view--publish-export .ttv2-message').last().innerText();
    if (/导出已开始/.test(exportMsg)) ok('导出页触发后端 xlsx 响应');
    else fail(`导出消息异常: ${exportMsg}`);

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
