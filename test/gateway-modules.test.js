import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import AdmZip from 'adm-zip';

import { createGatewayApp, setDevelopmentStaticHeaders } from '../gateway/app.js';
import { getGatewayConfig } from '../gateway/config/environment.js';
import { mapGatewayError } from '../gateway/middleware/error-handler.js';
import { getConfidenceThreshold } from '../gateway/middleware/intent-router.js';
import {
    createStaticVideoProxy,
    isAllowedManimStaticFilename,
    normalizeManimServiceUrl,
} from '../gateway/routes/static-video.js';
import { requireLocalApiToken } from '../gateway/security.js';
import { cleanupUploadsDirectory, ensureDirectory } from '../gateway/startup/uploads.js';
import { createDefaultTimetableProject } from '../gateway/services/timetable-project.js';
import { createTimetableStore } from '../gateway/services/timetable-store.js';

function xmlEscape(value = '') {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
    })[char]);
}

function buildConstraintWorkbook(rows = []) {
    const strings = rows.flat();
    const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">
${strings.map(value => `<si><t>${xmlEscape(value)}</t></si>`).join('')}
</sst>`;
    let stringIndex = 0;
    const sheetRows = rows.map((row, rowIndex) => {
        const cells = row.map((_, columnIndex) => {
            const ref = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
            return `<c r="${ref}" t="s"><v>${stringIndex++}</v></c>`;
        }).join('');
        return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    const zip = new AdmZip();
    zip.addFile('xl/sharedStrings.xml', Buffer.from(sharedStrings, 'utf8'));
    zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="AI约束建议" sheetId="1" r:id="rId1"/></sheets>
</workbook>`, 'utf8'));
    zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`, 'utf8'));
    zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`, 'utf8'));
    return zip.toBuffer();
}

test('gateway app can be constructed without starting the HTTP listener', () => {
    const app = createGatewayApp({ isDev: false });

    assert.equal(typeof app, 'function');
    assert.equal(app.get('trust proxy'), 1);
});

test('gateway host defaults to loopback unless remote access is explicitly allowed', () => {
    assert.equal(getGatewayConfig({}).host, '127.0.0.1');
    assert.equal(getGatewayConfig({ HOST: '0.0.0.0' }).host, '127.0.0.1');
    assert.equal(getGatewayConfig({ HOST: '0.0.0.0', ALLOW_REMOTE: 'true', ICECREAM_LOCAL_TOKEN: 'secret' }).host, '0.0.0.0');
    assert.equal(getGatewayConfig({ ALLOW_REMOTE: 'true', ICECREAM_LOCAL_TOKEN: 'secret' }).host, '0.0.0.0');
    assert.equal(getGatewayConfig({ ICECREAM_LOCAL_TOKEN: 'secret' }).localApiToken, 'secret');
});

test('local API token guard rejects remote admin requests without a token', () => {
    const guard = requireLocalApiToken({ token: 'secret', allowLoopback: false });
    const denied = runGuard(guard, { remoteAddress: '203.0.113.10' });
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.body.success, false);
    assert.equal(denied.body.data.reason, 'admin_token_required');

    const allowed = runGuard(guard, {
        remoteAddress: '203.0.113.10',
        headers: { authorization: 'Bearer secret' },
    });
    assert.equal(allowed.nextCalled, true);

    const loopbackGuard = requireLocalApiToken({ token: 'secret', allowLoopback: true });
    const loopback = runGuard(loopbackGuard, { remoteAddress: '127.0.0.1' });
    assert.equal(loopback.nextCalled, true);
});

test('production gateway errors hide internal details and include requestId', () => {
    const error = new Error('provider failed at https://internal.example.test/token with stack trace');
    const mapped = mapGatewayError(error, {
        requestId: 'req-test-123',
        isDev: false,
    });

    assert.equal(mapped.status, 500);
    assert.equal(mapped.payload.success, false);
    assert.equal(mapped.payload.requestId, 'req-test-123');
    assert.match(mapped.payload.error, /服务暂时不可用/);
    assert.doesNotMatch(JSON.stringify(mapped.payload), /internal\.example|token|stack trace/);
});

test('gateway mounts legacy timetable APIs', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    const previousDeepseekKey = process.env.DEEPSEEK_API_KEY;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-gateway-timetable-'));
    process.env.DEEPSEEK_API_KEY = '';
    process.env.OPENAI_API_KEY = '';
    const timetableStore = createTimetableStore();
    await timetableStore.saveProject(createDefaultTimetableProject({
        teachers: [{ id: 't1', name: '张老师' }],
        classes: [{ id: 'c1', grade: '一年级', name: '一班' }],
        subjects: [
            { id: 's1', name: '语文' },
            { id: 's2', name: '数学' },
        ],
        lessonPlans: [
            { id: 'lp_chinese', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyHours: 4, blockPreference: 'single' },
            { id: 'lp_math', classId: 'c1', subjectId: 's2', teacherId: 't1', weeklyHours: 4, blockPreference: 'single' },
        ],
    }));

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/tools/timetable/bootstrap`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        });

        assert.equal(response.status, 200);
        assert.ok(response.headers.get('content-type').includes('application/json'));

        const payload = await response.json();
        assert.equal(payload.success, true);
        assert.ok(payload.data);
        assert.ok('project' in payload.data);

        const chatResponse = await fetch(`http://127.0.0.1:${port}/api/tools/timetable/constraints/chat/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ constraints: [], project: {}, reviewContext: {} }),
        });
        assert.equal(chatResponse.status, 200);

        const chatPayload = await chatResponse.json();
        assert.equal(chatPayload.success, true);
        assert.ok(chatPayload.data.conversationId);

        const ruleReviewResponse = await fetch(`http://127.0.0.1:${port}/api/tools/timetable/rule-review/parse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '语文尽量安排到上午' }),
        });
        assert.equal(ruleReviewResponse.status, 200);
        const ruleReviewPayload = await ruleReviewResponse.json();
        assert.equal(ruleReviewPayload.success, true);
        assert.ok(ruleReviewPayload.data.draftRows.some(row => row.type === 'subject_morning' && row.targetId === 's1'));

        const workbook = buildConstraintWorkbook([
            ['约束内容'],
            ['语文尽量安排到上午'],
        ]);
        const ruleReviewForm = new FormData();
        ruleReviewForm.append('file', new Blob([workbook], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }), 'AI排课约束建议.xlsx');
        const xlsxRuleReviewResponse = await fetch(`http://127.0.0.1:${port}/api/tools/timetable/rule-review/parse`, {
            method: 'POST',
            body: ruleReviewForm,
        });
        assert.equal(xlsxRuleReviewResponse.status, 200);
        assert.match(xlsxRuleReviewResponse.headers.get('content-type') || '', /application\/json/);
        const xlsxRuleReviewPayload = await xlsxRuleReviewResponse.json();
        assert.equal(xlsxRuleReviewPayload.success, true);
        assert.ok(xlsxRuleReviewPayload.data.draftRows.some(row => row.type === 'subject_morning' && row.targetId === 's1'));

        const semanticApplyResponse = await fetch(`http://127.0.0.1:${port}/api/tools/timetable/requirements/apply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                actions: [
                    {
                        id: 'act_math_double',
                        kind: 'lesson_plan_patch',
                        target: { lessonPlanIds: ['lp_math'] },
                        patch: { blockPreference: 'double' },
                    },
                    {
                        id: 'act_teacher_consecutive',
                        kind: 'soft_rules_patch',
                        target: { teacherIds: ['t1'] },
                        patch: { teacherLimits: { consecutive: 3 }, balancedTeacherLoad: true },
                    },
                ],
            }),
        });
        assert.equal(semanticApplyResponse.status, 200);
        const semanticApplyPayload = await semanticApplyResponse.json();
        assert.equal(semanticApplyPayload.success, true);
        assert.equal(semanticApplyPayload.data.project.lessonPlans.find(plan => plan.id === 'lp_math').blockPreference, 'double');
        assert.equal(semanticApplyPayload.data.project.rules.softRules.teacherLimits.t1.consecutive, 3);
        assert.deepEqual(semanticApplyPayload.data.applied.map(item => item.id), ['act_math_double', 'act_teacher_consecutive']);

        const complexApplyResponse = await fetch(`http://127.0.0.1:${port}/api/tools/timetable/requirements/apply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                actions: [
                    {
                        id: 'act_complex_model',
                        kind: 'complex_model_patch',
                        patch: { timetableModelVersion: 'complex_v1' },
                    },
                    {
                        id: 'act_week_pattern',
                        kind: 'complex_model_patch',
                        target: { subjectIds: ['s1'] },
                        patch: { weekPattern: 'odd', preferredSlots: ['1-1'] },
                    },
                    {
                        id: 'act_room_requirement',
                        kind: 'complex_model_patch',
                        target: { subjectIds: ['s2'] },
                        patch: { roomRequirement: { roomName: '操场', preferredRoomIds: ['room_playground'], requiredTags: ['sport'] } },
                    },
                    {
                        id: 'act_teaching_group',
                        kind: 'complex_model_patch',
                        patch: { teachingGroup: { name: '一班数学合班组', classIds: ['c1'], subjectIds: ['s2'], mode: 'combined_class' } },
                    },
                    {
                        id: 'act_commute',
                        kind: 'complex_model_patch',
                        patch: { commuteRules: { defaultGapPeriods: 2 } },
                    },
                ],
            }),
        });
        assert.equal(complexApplyResponse.status, 200);
        const complexApplyPayload = await complexApplyResponse.json();
        assert.equal(complexApplyPayload.success, true);
        assert.equal(complexApplyPayload.data.project.timetableModelVersion, 'complex_v1');
        assert.equal(complexApplyPayload.data.project.complexModelEnabled, true);
        assert.equal(complexApplyPayload.data.project.rules.softRules.subjectPreferredPeriods.s1.weekPattern, 'odd');
        assert.equal(complexApplyPayload.data.project.lessonPlans.find(plan => plan.subjectId === 's1').weekPattern, 'odd');
        assert.ok(complexApplyPayload.data.project.rooms.some(room => room.id === 'room_playground' && room.name === '操场'));
        assert.deepEqual(complexApplyPayload.data.project.lessonPlans.find(plan => plan.subjectId === 's2').roomRequirement.preferredRoomIds, ['room_playground']);
        assert.ok(complexApplyPayload.data.project.teachingGroups.some(group => group.name === '一班数学合班组' && group.mode === 'combined_class'));
        assert.equal(complexApplyPayload.data.project.commuteRules.defaultGapPeriods, 2);
        assert.deepEqual(complexApplyPayload.data.applied.map(item => item.id), [
            'act_complex_model',
            'act_week_pattern',
            'act_room_requirement',
            'act_teaching_group',
            'act_commute',
        ]);

        const clarifyResponse = await fetch(`http://127.0.0.1:${port}/api/tools/timetable/requirements/clarify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                previousResult: {
                    requirementItems: [{
                        id: 'req_high_load',
                        object: { kind: 'derived_group', name: '高负载教师', matchedIds: ['t1'], scope: 'derived' },
                        intent: 'teacher_load_protection',
                        status: 'needs_review',
                        applyTo: 'optimization',
                        parameters: { balancedTeacherLoad: true },
                        clarification: {
                            id: 'clarify_req_high_load_max_consecutive',
                            kind: 'number',
                            field: 'maxConsecutive',
                            question: '连续超过几节算太多？',
                            defaultValue: 3,
                        },
                    }],
                    semanticActions: [],
                    draftRows: [],
                },
                answers: [{ requirementId: 'req_high_load', field: 'maxConsecutive', value: 2 }],
            }),
        });
        assert.equal(clarifyResponse.status, 200);
        const clarifyPayload = await clarifyResponse.json();
        assert.equal(clarifyPayload.success, true);
        assert.equal(clarifyPayload.data.requirementItems[0].status, 'actionable');
        assert.equal(clarifyPayload.data.semanticActions[0].patch.teacherLimits.consecutive, 2);

        const sharedResponse = await fetch(`http://127.0.0.1:${port}/shared/seating/classroom-layout.js`);
        const sharedSource = await sharedResponse.text();
        assert.equal(sharedResponse.status, 200);
        assert.match(sharedSource, /export const CELL/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
        if (previousDeepseekKey === undefined) {
            delete process.env.DEEPSEEK_API_KEY;
        } else {
            process.env.DEEPSEEK_API_KEY = previousDeepseekKey;
        }
        if (previousOpenAiKey === undefined) {
            delete process.env.OPENAI_API_KEY;
        } else {
            process.env.OPENAI_API_KEY = previousOpenAiKey;
        }
    }
});

test('backend modules do not import browser public modules', async () => {
    const roots = [
        path.resolve('gateway'),
        path.resolve('services'),
    ];
    const files = [];
    for (const root of roots) {
        files.push(...await collectJsFiles(root));
    }

    const offenders = [];
    const publicImportPattern = /(?:from\s+['"][^'"]*public[\\/]|import\(\s*['"][^'"]*public[\\/]|require\(\s*['"][^'"]*public[\\/])/;
    for (const file of files) {
        const source = await readFile(file, 'utf8');
        if (publicImportPattern.test(source)) {
            offenders.push(path.relative(process.cwd(), file).replace(/\\/g, '/'));
        }
    }

    assert.deepEqual(offenders, []);
});

function runGuard(guard, options = {}) {
    const headers = new Map(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const result = { statusCode: 200, body: null, nextCalled: false };
    const req = {
        socket: { remoteAddress: options.remoteAddress || '127.0.0.1' },
        get(name) {
            return headers.get(String(name).toLowerCase());
        },
    };
    const res = {
        status(code) {
            result.statusCode = code;
            return this;
        },
        json(body) {
            result.body = body;
            return this;
        },
    };
    guard(req, res, () => {
        result.nextCalled = true;
    });
    return result;
}

async function collectJsFiles(root) {
    const entries = await readdir(root, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectJsFiles(fullPath));
        } else if (entry.isFile() && fullPath.endsWith('.js')) {
            files.push(fullPath);
        }
    }
    return files;
}

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
