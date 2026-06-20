/**
 * Phase 6 集成验证：真实 gateway + 真实 V2 路由 + 已提交 bundle（USE_MOCK=false）。
 * 起 gateway → Playwright 加载工作台 bundle → 经真实后端走求解 → 抓控制台 error。
 * 运行：node test/timetable-v2-integration-verify.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = 3208;
const PROBE = 'public/js/tools/timetable-v2/__iverify.html';
const gw = spawn(process.execPath, ['gateway/server.js'], {
    env: { ...process.env, PORT: String(PORT), TIMETABLE_V2_ENABLED: 'true' },
    stdio: 'ignore',
});

function fail(m) { console.error('❌ ' + m); process.exitCode = 1; }
function ok(m) { console.log('✅ ' + m); }

async function waitHealth() {
    for (let i = 0; i < 30; i++) {
        try {
            const r = await fetch(`http://localhost:${PORT}/api/health`);
            if (r.ok) return await r.json();
        } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('gateway 未就绪');
}

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>
<body><div id="app" style="height:100vh"></div>
<script type="module">
import mod from './dist/workbench.bundle.js';
window.__err = null;
window.addEventListener('error', e => window.__err = String(e.error || e.message));
window.addEventListener('unhandledrejection', e => window.__err = String(e.reason));
try { window.__wb = mod.init(document.getElementById('app')); window.__ready = true; }
catch (e) { window.__err = String(e && e.stack || e); window.__ready = false; }
</script></body></html>`;
writeFileSync(PROBE, html);

try {
    const health = await waitHealth();
    if (health.timetableV2Enabled === true) ok('health 开关 timetableV2Enabled=true'); else fail('health 开关异常');

    const browser = await chromium.launch();
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push(String(e)));
    page.on('response', r => { if (r.status() === 404) consoleErrors.push(`404: ${r.url()}`); });

    await page.goto(`http://localhost:${PORT}/js/tools/timetable-v2/__iverify.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    const ready = await page.evaluate(() => window.__ready);
    const err = await page.evaluate(() => window.__err);
    if (ready) ok('已提交 bundle 经真实 gateway 加载并挂载'); else fail(`挂载失败: ${err}`);

    // 经真实后端跑一次求解（USE_MOCK=false）
    const solveRes = await fetch(`http://localhost:${PORT}/api/tools/timetable-v2/schedule/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: {
            id: 'iv', calendar: { weekdays: 5, periodsPerDay: 6 },
            classes: [{ id: 'c1', name: 'C1' }], teachers: [{ id: 't1', name: 'T1' }],
            subjects: [{ id: 's1', name: 'S1', category: 'main', priority: 90 }], rooms: [],
            activityPlans: [{ id: 'a1', classIds: ['c1'], subjectId: 's1', teacherIds: ['t1'], weeklyUnits: 5 }],
            constraints: [],
        } }),
    });
    const solveData = await solveRes.json();
    if (solveData.success && solveData.data.stats.placed === 5 && solveData.data.hardConflicts.length === 0) {
        ok('真实路由求解：5 节全排、零硬冲突、含诊断');
    } else fail(`真实路由求解异常: ${JSON.stringify(solveData).slice(0, 200)}`);

    if (consoleErrors.length === 0) ok('控制台无 error'); else fail(`控制台 error: ${consoleErrors.slice(0, 3).join(' | ')}`);

    await browser.close();
    console.log(process.exitCode ? '\n集成验证未全过' : '\n✅ Phase 6 集成验证全过');
} finally {
    gw.kill();
    try { rmSync(PROBE); } catch { /* ignore */ }
}
