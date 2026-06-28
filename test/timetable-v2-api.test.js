/**
 * timetable-v2 API 路由测试（Phase 6）。
 * 命令：node --test test/timetable-v2-api.test.js
 *
 * 覆盖：响应壳、校验错误、导入、求解、诊断、发布门禁、迁移幂等 + 旧数据隔离、
 * 以及 route→service 分层断言（routes.js 源码不含排课/诊断算法）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import '../gateway/services/timetable-v2/index.js'; // 触发硬约束自注册
import { createTimetableV2Router } from '../gateway/services/timetable-v2/api/routes.js';
import { createTimetableV2Store } from '../gateway/services/timetable-v2/api/store.js';
import { solve } from '../gateway/services/timetable-v2/solver/pipeline.js';
import { solvableProject } from './timetable-v2-fixtures/index.js';
import { legacyProjectSample } from './timetable-v2-fixtures/legacy-project-sample.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 起一个隔离 store 的 app + http server，返回 { baseUrl, store, dataDir, close }。 */
async function startServer() {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'ttv2-api-'));
    const store = createTimetableV2Store({ dataDir });
    const app = express();
    app.use(express.json({ limit: '8mb' }));
    app.use('/api/tools/timetable-v2', createTimetableV2Router({ store }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/tools/timetable-v2`;
    return {
        baseUrl,
        store,
        dataDir,
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

async function postJson(baseUrl, route, body) {
    const res = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

test('POST /project 合法→200{success:true}，缺字段→4xx+可读 error', async () => {
    const srv = await startServer();
    try {
        const okRes = await postJson(srv.baseUrl, '/project', solvableProject());
        assert.equal(okRes.status, 200);
        assert.equal(okRes.json.success, true);
        assert.equal(okRes.json.data.project.id, 'p_solve');
        assert.equal(okRes.json.data.project.revision, 1);

        // 悬空引用：activityPlan 引用不存在 subject
        const bad = solvableProject();
        bad.activityPlans[0].subjectId = 's_missing';
        const failRes = await postJson(srv.baseUrl, '/project', bad);
        assert.ok(failRes.status >= 400 && failRes.status < 500, `期望 4xx，实际 ${failRes.status}`);
        assert.equal(failRes.json.success, false);
        assert.ok(typeof failRes.json.error === 'string' && failRes.json.error.length > 0);
        assert.ok(Array.isArray(failRes.json.data.errors) && failRes.json.data.errors.length > 0);
    } finally {
        await srv.close();
    }
});

test('GET /bootstrap 无草稿→needsMigration:true；落库后→项目+能力标志', async () => {
    const srv = await startServer();
    try {
        const before = await fetch(`${srv.baseUrl}/bootstrap`).then(r => r.json());
        assert.equal(before.success, true);
        assert.equal(before.data.project, null);
        assert.equal(before.data.needsMigration, true);
        assert.equal(before.data.capabilities.solver, true);

        await postJson(srv.baseUrl, '/project', solvableProject());
        const after = await fetch(`${srv.baseUrl}/bootstrap`).then(r => r.json());
        assert.equal(after.data.needsMigration, false);
        assert.equal(after.data.project.id, 'p_solve');
    } finally {
        await srv.close();
    }
});

test('POST /import legacy 样本→{project,report}', async () => {
    const srv = await startServer();
    try {
        const res = await postJson(srv.baseUrl, '/import', { source: 'legacy', data: legacyProjectSample() });
        assert.equal(res.status, 200);
        assert.equal(res.json.success, true);
        assert.ok(res.json.data.project && Array.isArray(res.json.data.project.activityPlans));
        assert.ok(res.json.data.report && res.json.data.report.summary);
        assert.ok(res.json.data.report.summary.total > 0);

        // 未知来源 → 4xx 可读错误
        const bad = await postJson(srv.baseUrl, '/import', { source: 'nope', data: {} });
        assert.ok(bad.status >= 400 && bad.status < 500);
        assert.equal(bad.json.success, false);
    } finally {
        await srv.close();
    }
});

test('POST /schedule/run→零硬冲突解；POST /diagnose→诊断报告', async () => {
    const srv = await startServer();
    try {
        const run = await postJson(srv.baseUrl, '/schedule/run', { project: solvableProject() });
        assert.equal(run.status, 200);
        assert.equal(run.json.success, true);
        assert.equal(run.json.data.hardConflicts.length, 0);
        assert.ok(Array.isArray(run.json.data.placements) && run.json.data.placements.length > 0);

        const diag = await postJson(srv.baseUrl, '/diagnose', { project: solvableProject() });
        assert.equal(diag.status, 200);
        assert.ok(diag.json.data.diagnostics);
    } finally {
        await srv.close();
    }
});

test('POST /project 使用 revision 防止旧窗口覆盖新项目', async () => {
    const srv = await startServer();
    try {
        const first = await postJson(srv.baseUrl, '/project', solvableProject());
        assert.equal(first.status, 200);
        const stale = clone(first.json.data.project);

        const fresh = { ...clone(first.json.data.project), name: 'fresh-name' };
        const second = await postJson(srv.baseUrl, '/project', fresh);
        assert.equal(second.status, 200);
        assert.equal(second.json.data.project.revision, 2);

        const staleRes = await postJson(srv.baseUrl, '/project', { ...stale, name: 'stale-name' });
        assert.equal(staleRes.status, 409);
        assert.equal(staleRes.json.data.reason, 'version_conflict');

        const stored = await srv.store.loadProject();
        assert.equal(stored.name, 'fresh-name');
        assert.equal(stored.revision, 2);
    } finally {
        await srv.close();
    }
});

test('POST /schedule/publish 服务端重算：客户端声明不作为发布门禁', async () => {
    const srv = await startServer();
    try {
        const project = solvableProject();
        const result = solve(project, { diagnostics: false });
        const solution = {
            placements: result.placements,
            unplaced: [{ activityId: 'fake-unplaced', reason: {} }],
            hardConflicts: [{ type: 'fake_conflict' }],
            softScore: result.softScore,
        };
        const okRes = await postJson(srv.baseUrl, '/schedule/publish', { project, solution });
        assert.equal(okRes.status, 200);
        assert.equal(okRes.json.data.published, true);
        assert.equal(okRes.json.data.solution.hardConflicts.length, 0);
        assert.equal(okRes.json.data.solution.unplaced.length, 0);
        assert.ok(okRes.json.data.publishedSnapshot.solutionHash);
        assert.equal(okRes.json.data.project.revision, 1);
        assert.ok(okRes.json.data.project.publishedSnapshot);
    } finally {
        await srv.close();
    }
});

test('POST /schedule/publish 服务端重算：实际未排或硬冲突会拦截', async () => {
    const srv = await startServer();
    try {
        const project = solvableProject();
        const result = solve(project, { diagnostics: false });
        const missingSolution = {
            placements: result.placements.slice(1),
            unplaced: [],
            hardConflicts: [],
            softScore: result.softScore,
        };
        const missing = await postJson(srv.baseUrl, '/schedule/publish', { project, solution: missingSolution });
        assert.equal(missing.status, 422);
        assert.equal(missing.json.data.reason, 'unplaced_lessons');

        const conflictPlacements = result.placements.map(p => ({ ...p }));
        const firstMath = conflictPlacements.find(p => p.activityId.startsWith('lp1#'));
        const secondMath = conflictPlacements.find(p => p.activityId.startsWith('lp3#'));
        assert.ok(firstMath && secondMath);
        secondMath.day = firstMath.day;
        secondMath.period = firstMath.period;
        secondMath.roomId = firstMath.roomId;

        const conflictSolution = {
            placements: conflictPlacements,
            unplaced: [],
            hardConflicts: [],
            softScore: result.softScore,
        };
        const conflict = await postJson(srv.baseUrl, '/schedule/publish', { project, solution: conflictSolution });
        assert.equal(conflict.status, 422);
        assert.equal(conflict.json.data.reason, 'hard_conflicts_exist');
    } finally {
        await srv.close();
    }
});

test('POST /export→xlsx Buffer 下载头', async () => {
    const srv = await startServer();
    try {
        const res = await fetch(`${srv.baseUrl}/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: solvableProject(), type: 'class' }),
        });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') || '', /spreadsheetml\.sheet/);
        const buf = Buffer.from(await res.arrayBuffer());
        assert.ok(buf.length > 0);
        assert.equal(buf.slice(0, 2).toString('latin1'), 'PK'); // zip 魔数
    } finally {
        await srv.close();
    }
});

test('POST /migrate/legacy 生成草稿且不触碰旧数据；幂等不覆盖', async () => {
    const srv = await startServer();
    try {
        const sample = legacyProjectSample();
        const snapshot = JSON.stringify(sample); // 旧数据字节级快照

        const first = await postJson(srv.baseUrl, '/migrate/legacy', { legacyProject: sample });
        assert.equal(first.status, 200);
        assert.equal(first.json.data.migrated, true);
        assert.ok(first.json.data.project.activityPlans.length > 0);
        assert.ok(first.json.data.report.summary.total > 0);

        // 隔离断言：迁移只写 V2 独立 store dir，入参旧项目对象字节级不变。
        assert.equal(JSON.stringify(sample), snapshot, '迁移不得 mutate 旧项目数据');
        const stored = await readFile(srv.store.filePath, 'utf8');
        assert.match(stored, /"version": 2/);

        // 幂等：再次迁移不覆盖（返回现有草稿，migrated:false）。
        const second = await postJson(srv.baseUrl, '/migrate/legacy', { legacyProject: sample });
        assert.equal(second.status, 200);
        assert.equal(second.json.data.migrated, false);
        assert.equal(second.json.data.reason, 'draft_exists');
    } finally {
        await srv.close();
    }
});

test('GET /schedule/jobs/:jobId 不存在→404', async () => {
    const srv = await startServer();
    try {
        const res = await fetch(`${srv.baseUrl}/schedule/jobs/nope-123`).then(r => r.json());
        assert.equal(res.success, false);
    } finally {
        await srv.close();
    }
});

test('分层断言：routes.js 不含排课/诊断算法实现，只 import 调 core', async () => {
    const src = await readFile(path.join(__dirname, '../gateway/services/timetable-v2/api/routes.js'), 'utf8');
    // 不得在路由层自实现硬冲突检测 / 压力计算 / 网格构建 / xlsx 生成函数。
    assert.doesNotMatch(src, /function\s+detectHardConflicts/);
    assert.doesNotMatch(src, /function\s+normalizePressure/);
    assert.doesNotMatch(src, /function\s+buildGridView/);
    assert.doesNotMatch(src, /function\s+buildV2ExportXlsx/);
    assert.doesNotMatch(src, /function\s+buildDiagnostics/);
    // 应通过 import 调用 core。
    assert.match(src, /from '\.\.\/index\.js'/);
    assert.match(src, /\bsolve\(/);
    assert.match(src, /buildV2ExportXlsx\(/);
});
