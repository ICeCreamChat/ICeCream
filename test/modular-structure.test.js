import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../', import.meta.url);

async function exists(path) {
    try {
        await stat(new URL(path, projectRoot));
        return true;
    } catch {
        return false;
    }
}

test('project exposes the new modular source and documentation map', async () => {
    const requiredPaths = [
        'src/shared/api.ts',
        'src/shared/seating.ts',
        'src/server/app.ts',
        'src/server/main.ts',
        'src/server/clients/manim-service.ts',
        'src/server/clients/timefold.ts',
        'src/server/config/environment.js',
        'src/server/config/paths.js',
        'src/server/middleware/core.js',
        'src/server/routes/health.js',
        'src/server/security.js',
        'src/server/modules/seating/routes.ts',
        'src/server/modules/seating/services/arrange.js',
        'src/server/modules/seating/services/roster.js',
        'src/server/modules/seating/arrange/index.ts',
        'src/server/modules/seating/chat/index.ts',
        'src/server/modules/seating/constraints/index.ts',
        'src/server/modules/seating/feedback/index.ts',
        'src/server/modules/seating/layout/index.ts',
        'src/server/modules/seating/roster/index.ts',
        'src/server/modules/seating/timefold/index.ts',
        'src/server/modules/chat/routes.ts',
        'src/server/modules/assistant/routes.ts',
        'src/server/modules/manim/routes.ts',
        'src/server/modules/solver/routes.ts',
        'src/client/app.js',
        'src/client/main.ts',
        'src/client/tools/registry.ts',
        'src/client/tools/seating/index.ts',
        'src/client/tools/seating/seating-planner.js',
        'src/client/styles/main.css',
        'docs/ARCHITECTURE.md',
        'docs/MODULE_MAP.md',
        'docs/API_REFERENCE.md',
        'docs/FRONTEND_GUIDE.md',
        'docs/SEATING_GUIDE.md',
        'docs/MANIM_SERVICE.md',
        'docs/DEVELOPMENT.md',
    ];

    for (const path of requiredPaths) {
        assert.equal(await exists(path), true, `${path} should exist`);
    }
});

test('root Vite entry preserves the full legacy app shell instead of the minimal modular demo', async () => {
    const rootIndex = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const clientEntry = await readFile(new URL('../src/client/main.ts', import.meta.url), 'utf8');

    assert.match(rootIndex, /id="apps-btn"/);
    assert.match(rootIndex, /data-mode="chat"/);
    assert.match(rootIndex, /data-mode="manim"/);
    assert.match(rootIndex, /data-mode="solver"/);
    assert.match(rootIndex, /src="\/src\/client\/main\.ts"/);
    assert.doesNotMatch(rootIndex, /src="\/src\/client\/tools\/app-launcher\.js"/);
    assert.doesNotMatch(rootIndex, /src="\/src\/client\/app\.js"/);
    assert.match(rootIndex, /href="\/src\/client\/styles\/main\.css"/);
    assert.doesNotMatch(rootIndex, /src="\/?js\//);
    assert.doesNotMatch(rootIndex, /href="\/?css\//);
    assert.doesNotMatch(rootIndex, /modular-home|Modular client entry/);
    assert.doesNotMatch(clientEntry, /modular-home|Modular client entry/);
});

test('package scripts use the TypeScript and Vite modular entrypoints', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    assert.match(pkg.scripts.start, /src\/server\/main\.ts/);
    assert.match(pkg.scripts.dev, /concurrently/);
    assert.match(pkg.scripts['dev:server'], /tsx/);
    assert.match(pkg.scripts['dev:client'], /vite/);
    assert.match(pkg.scripts.build, /vite build/);
    assert.match(pkg.scripts.test, /tsx --test|--import tsx/);
});

test('dev.bat is the new one-click modular development entrypoint', async () => {
    const source = await readFile(new URL('../dev.bat', import.meta.url), 'utf8');

    assert.match(source, /npm run dev/);
    assert.match(source, /src\/server\/main\.ts|src\\server\\main\.ts/);
    assert.match(source, /python\.exe -m app\.main|python -m app\.main/);
    assert.match(source, /http:\/\/127\.0\.0\.1:(5173|%FRONTEND_PORT%)/);
    assert.match(source, /http:\/\/127\.0\.0\.1:(3000|%BACKEND_PORT%)/);
    assert.doesNotMatch(source, /node gateway\/server\.js|node gateway\\server\.js/);
    assert.doesNotMatch(source, /manim-service\\main\.py|manim-service\/main\.py/);
    assert.doesNotMatch(source, /\.venv\\Scripts\\python\.exe main\.py/);
});

test('new seating API module is mounted as a first-class API domain', async () => {
    const { createServerApp } = await import('../src/server/app.ts');
    const server = createServerApp({ isDev: false }).listen(0);

    try {
        const address = server.address();
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const response = await fetch(`${baseUrl}/api/seating/health`);
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.data.service, 'seating');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('modular seating roster imports return JSON without legacy compatibility routes', async () => {
    const { createServerApp } = await import('../src/server/app.ts');
    const logger = { log() {}, warn() {}, error() {} };
    const server = createServerApp({ isDev: false, logger }).listen(0);

    try {
        const address = server.address();
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const textResponse = await fetch(`${baseUrl}/api/seating/roster/parse-text`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '张三 男 93 142\n李四 女 88 151' }),
        });
        assert.match(textResponse.headers.get('content-type') || '', /application\/json/);
        const textPayload = await textResponse.json();

        assert.equal(textResponse.status, 200);
        assert.equal(textPayload.success, true);
        assert.equal(textPayload.data.count, 2);

        const form = new FormData();
        form.append('file', new Blob(['张三,男,93,142\n李四,女,88,151'], { type: 'text/csv' }), 'students.csv');
        const fileResponse = await fetch(`${baseUrl}/api/seating/roster/parse-file`, {
            method: 'POST',
            body: form,
        });
        assert.match(fileResponse.headers.get('content-type') || '', /application\/json/);
        const filePayload = await fileResponse.json();

        assert.equal(fileResponse.status, 200);
        assert.equal(filePayload.success, true);
        assert.equal(filePayload.data.count, 2);

        const legacyResponse = await fetch(`${baseUrl}/api/tools/seating/parse-students`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '寮犱笁 鐢?93 142' }),
        });
        assert.equal(legacyResponse.status, 404);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('runtime source no longer depends on legacy gateway, services, or public code directories', async () => {
    const legacyPaths = [
        'gateway',
        'services',
        `public/${'index.html'}`,
        `public/${'js'}`,
        `public/${'css'}`,
        `manim-service/${'main.py'}`,
    ];
    for (const legacyPath of legacyPaths) {
        assert.equal(await exists(legacyPath), false, `${legacyPath} should be removed`);
    }

    const sourceRoots = ['src', 'test', 'scripts', 'manim-service/app'];
    const files = [];
    for (const root of sourceRoots) {
        const rootUrl = new URL(`../${root}/`, import.meta.url);
        const walk = async dir => {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const child = new URL(entry.name, `${dir.href.endsWith('/') ? dir.href : `${dir.href}/`}`);
                if (entry.isDirectory()) {
                    await walk(child);
                } else if (/\.(js|ts|py|html|css|md|json)$/.test(entry.name)) {
                    files.push(child);
                }
            }
        };
        await walk(rootUrl);
    }

    for (const file of files) {
        if (file.pathname.endsWith('/modular-structure.test.js')) {
            continue;
        }
        const text = await readFile(file, 'utf8');
        assert.doesNotMatch(text, /\.\.\/gateway|\.\.\/\.\.\/gateway|\.\.\/services|\.\.\/\.\.\/services/);
        assert.doesNotMatch(text, /public\/js|public\\js|public\/css|public\\css|public\/index\.html/);
        assert.doesNotMatch(text, /manim-service\/main\.py|manim-service\\main\.py/);
    }
});
