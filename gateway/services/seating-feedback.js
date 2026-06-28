import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { gatewayPaths } from '../config/paths.js';
import { redactSensitiveText, sanitizeDiagnosticValue } from './diagnostic-redaction.js';

const FEEDBACK_FILE = 'seating-feedback.jsonl';
const FEEDBACK_ASSET_DIR = 'seating-feedback-assets';
const MAX_SCREENSHOT_DATA_URL_LENGTH = 1_500_000;
const DEFAULT_FEEDBACK_RETENTION_DAYS = 180;
const CATEGORY_LABELS = {
    understand: '排座要求没听懂',
    result: '座位结果不对',
    guardian: '护法/微调不对',
    ui: '界面/导出问题',
    other: '其他',
};
const SEVERITY_LABELS = {
    blocking: '影响使用',
    workaround: '还能绕过',
    suggestion: '只是建议',
};

export function clipText(value, maxLength) {
    return String(value ?? '').trim().slice(0, maxLength);
}

export function normalizeSeatingFeedbackRequest(body = {}) {
    const message = clipText(redactSensitiveText(body.message, 2500), 2000);
    if (message.length < 5) {
        throw new Error('请至少填写 5 个字的反馈内容');
    }

    const category = CATEGORY_LABELS[body.category] ? body.category : 'other';
    const severity = SEVERITY_LABELS[body.severity] ? body.severity : 'workaround';
    const screenshot = normalizeFeedbackScreenshot(body.screenshot);

    return {
        message,
        expected: clipText(redactSensitiveText(body.expected, 1500), 1000),
        category,
        severity,
        snapshot: sanitizeJsonValue(body.snapshot, 220000),
        client: sanitizeJsonValue(body.client, 12000),
        screenshot: screenshot?.metadata || null,
        screenshotUpload: screenshot?.upload || null,
    };
}

function sanitizeJsonValue(value, maxLength) {
    return sanitizeDiagnosticValue(value, { maxLength, maxTextLength: 1000 });
}

function normalizeScreenshotDimension(value) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number) || number <= 0 || number > 20000) return null;
    return number;
}

function isValidBase64(value) {
    if (typeof value !== 'string' || !value || value.length % 4 !== 0) return false;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    try {
        const normalized = Buffer.from(value, 'base64').toString('base64');
        return normalized.replace(/=+$/, '') === value.replace(/=+$/, '');
    } catch {
        return false;
    }
}

function normalizeFeedbackScreenshot(input) {
    if (!input || typeof input !== 'object') return null;
    const dataUrl = String(input.dataUrl || '');
    if (!dataUrl || dataUrl.length > MAX_SCREENSHOT_DATA_URL_LENGTH) return null;

    const match = dataUrl.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/);
    if (!match || !isValidBase64(match[2])) return null;

    const mimeType = match[1];
    const declaredMimeType = String(input.mimeType || '').toLowerCase();
    if (declaredMimeType && declaredMimeType !== mimeType) return null;

    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length) return null;

    const extension = mimeType === 'image/png' ? 'png' : 'jpg';
    return {
        metadata: {
            included: true,
            privacyMode: input.privacyMode === 'full' ? 'full' : 'redacted',
            mimeType,
            width: normalizeScreenshotDimension(input.width),
            height: normalizeScreenshotDimension(input.height),
            capturedAt: clipText(input.capturedAt || new Date().toISOString(), 80),
            target: 'seating-tool',
        },
        upload: { buffer, extension },
    };
}

export function createFeedbackId(now = new Date()) {
    const stamp = now.toISOString()
        .replace(/\D/g, '')
        .slice(0, 14);
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `FB-${stamp}-${suffix}`;
}

export function buildLocalFeedbackSummary(feedback) {
    const categoryLabel = CATEGORY_LABELS[feedback.category] || CATEGORY_LABELS.other;
    const severityLabel = SEVERITY_LABELS[feedback.severity] || SEVERITY_LABELS.workaround;
    const compactMessage = feedback.message.replace(/\s+/g, ' ');
    const title = `${categoryLabel}：${compactMessage.slice(0, 36)}${compactMessage.length > 36 ? '...' : ''}`;

    return {
        title,
        category: feedback.category,
        categoryLabel,
        severity: feedback.severity,
        severityLabel,
        userIntent: feedback.expected || '',
        observed: feedback.message,
        expected: feedback.expected || '',
        reproSteps: [
            '打开座位安排工具',
            '按反馈记录中的脱敏快照恢复相同人数、布局、策略和排座要求',
            '执行用户描述的操作并对比观察结果',
        ],
        suspectedArea: inferSuspectedArea(feedback),
        debugHints: [
            '反馈内容已脱敏，stu_001 等编号对应同一条反馈内的匿名学生',
            '先查看 snapshot.arrangementInterpretation、snapshot.arrangementStats 和 snapshot.quality',
        ],
        confidence: 0.65,
    };
}

function inferSuspectedArea(feedback) {
    if (feedback.category === 'guardian') return 'seating-chat / guardian operations';
    if (feedback.category === 'understand') return 'seating-arrange natural language interpretation';
    if (feedback.category === 'result') return 'seating-arrange / seating-solver-bridge';
    if (feedback.category === 'ui') return 'seating-planner UI';
    return 'seating planner';
}

export function getFeedbackLogPath(env = process.env) {
    const logDir = env.FEEDBACK_LOG_DIR || path.join(gatewayPaths.projectRoot, 'logs');
    return path.join(logDir, FEEDBACK_FILE);
}

function getFeedbackAssetPath(fileName, env = process.env) {
    const safeName = path.basename(String(fileName || '').replace(/\\/g, '/'));
    return path.join(path.dirname(getFeedbackLogPath(env)), FEEDBACK_ASSET_DIR, safeName);
}

export function getFeedbackAssetDir(env = process.env) {
    return path.join(path.dirname(getFeedbackLogPath(env)), FEEDBACK_ASSET_DIR);
}

export function getFeedbackRetentionDays(env = process.env) {
    const raw = env.FEEDBACK_RETENTION_DAYS;
    if (raw === '0') return 0;
    const days = Number(raw);
    if (!Number.isFinite(days) || days <= 0) return DEFAULT_FEEDBACK_RETENTION_DAYS;
    return Math.floor(Math.min(days, 3650));
}

function isExpiredIsoDate(value, cutoffMs) {
    const time = Date.parse(value);
    return Number.isFinite(time) && time < cutoffMs;
}

function parseFeedbackLine(line) {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

function collectFeedbackAssetName(record) {
    const fileName = record?.raw?.screenshot?.fileName;
    if (!fileName) return null;
    return path.basename(String(fileName).replace(/\\/g, '/'));
}

async function safeUnlink(filePath) {
    try {
        await unlink(filePath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

async function cleanupOrphanFeedbackAssets(assetDir, cutoffMs, keptAssetNames) {
    let removed = 0;
    let entries = [];
    try {
        entries = await readdir(assetDir, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return 0;
        throw error;
    }

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (keptAssetNames.has(entry.name)) continue;
        const filePath = path.join(assetDir, entry.name);
        const info = await stat(filePath);
        if (info.mtimeMs >= cutoffMs) continue;
        if (await safeUnlink(filePath)) removed += 1;
    }
    return removed;
}

async function saveFeedbackScreenshotAsset(id, upload, env = process.env) {
    if (!upload?.buffer?.length || !upload.extension) return null;
    const safeId = String(id).replace(/[^A-Za-z0-9-]/g, '_');
    const fileName = `${FEEDBACK_ASSET_DIR}/${safeId}.${upload.extension}`;
    const fullPath = getFeedbackAssetPath(fileName, env);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, upload.buffer);
    return {
        fileName,
        byteLength: upload.buffer.length,
    };
}

export function buildFeedbackEmail(record, env = process.env) {
    const to = clipText(env.FEEDBACK_TO_EMAIL, 320);
    const from = clipText(env.FEEDBACK_FROM_EMAIL || env.SMTP_USER, 320);
    if (!to || !from) return null;

    const snapshot = record.snapshot || {};
    const backendDiagnostics = snapshot.backendDiagnostics || {};
    const quality = snapshot.quality || {};
    const stats = snapshot.arrangementStats || {};
    const quickDiagnosis = [
        `AI: ${backendDiagnostics.ai?.online ? 'online' : 'offline'} (${backendDiagnostics.ai?.reason || 'unknown'})`,
        `Timefold: configured=${Boolean(backendDiagnostics.timefold?.configured)} online=${Boolean(backendDiagnostics.timefold?.online)} fallback=${backendDiagnostics.timefold?.fallbackReason || stats.fallbackReason || 'none'}`,
        `Arrangement source: ${snapshot.arrangementSource || 'unknown'}`,
        `Score: percent=${quality.percent ?? 'unknown'} feasible=${quality.feasible ?? 'unknown'} hardViolations=${quality.hardViolationCount ?? 'unknown'}`,
        `Solver score: hard=${stats.hardScore ?? 'unknown'} soft=${stats.softScore ?? 'unknown'} score=${stats.score ?? 'unknown'}`,
    ].join('\n');

    const text = [
        `反馈编号：${record.id}`,
        `提交时间：${record.createdAt}`,
        `问题类型：${record.summary.categoryLabel}`,
        `影响程度：${record.summary.severityLabel}`,
        '',
        '用户反馈：',
        record.raw.message,
        '',
        '用户希望：',
        record.raw.expected || '未填写',
        '',
        '开发摘要：',
        record.summary.title,
        '',
        'Quick Diagnosis:',
        quickDiagnosis,
        '',
        'Backend Diagnostics:',
        JSON.stringify(backendDiagnostics || {}, null, 2),
        '',
        'Reproduction:',
        '1. Import the anonymized students/layout from snapshot.students and snapshot.layout.',
        '2. Use snapshot.arrangePrompt and snapshot.arrangementInterpretation to replay the request.',
        '3. Follow snapshot.diagnosticEvents in order and compare quality/constraint summaries.',
        '',
        'Full Redacted JSON:',
        JSON.stringify(sanitizeDiagnosticValue({
            id: record.id,
            raw: record.raw,
            summary: record.summary,
            snapshot: record.snapshot,
            client: record.client,
        }, { maxLength: 180000, maxTextLength: 1000 }), null, 2),
    ].join('\n');
    const screenshot = record.raw?.screenshot || null;
    const attachments = screenshot?.fileName
        ? [{
            filename: `${String(record.id).replace(/[^A-Za-z0-9-]/g, '_')}.${screenshot.mimeType === 'image/png' ? 'png' : 'jpg'}`,
            path: getFeedbackAssetPath(screenshot.fileName, env),
            contentType: screenshot.mimeType || 'image/jpeg',
        }]
        : [];

    return {
        from,
        to,
        subject: `ICeCream 座位反馈 ${record.id} - ${record.summary.categoryLabel}`,
        text,
        attachments,
    };
}

export function hasMailConfig(env = process.env) {
    return Boolean(
        env.FEEDBACK_TO_EMAIL &&
        (env.FEEDBACK_FROM_EMAIL || env.SMTP_USER) &&
        env.SMTP_HOST &&
        env.SMTP_USER &&
        env.SMTP_PASS
    );
}

async function resolveMailer(env = process.env) {
    const nodemailer = await import('nodemailer');
    return nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT || 465),
        secure: String(env.SMTP_SECURE ?? 'true') !== 'false',
        auth: {
            user: env.SMTP_USER,
            pass: env.SMTP_PASS,
        },
    });
}

export async function sendFeedbackEmail(record, options = {}) {
    const env = options.env || process.env;
    if (!hasMailConfig(env)) {
        return { sent: false, skippedReason: 'missing_email_config' };
    }

    const message = buildFeedbackEmail(record, env);
    if (!message) return { sent: false, skippedReason: 'missing_email_config' };

    const mailer = options.mailer || await resolveMailer(env);
    const result = await mailer.sendMail(message);
    return {
        sent: true,
        messageId: result?.messageId || null,
    };
}

export async function submitSeatingFeedback(options = {}) {
    const env = options.env || process.env;
    const now = options.now || new Date();
    const raw = normalizeSeatingFeedbackRequest(options.body || {});
    const id = options.id || createFeedbackId(now);
    const screenshotUpload = raw.screenshotUpload || null;
    delete raw.screenshotUpload;
    if (raw.screenshot && screenshotUpload) {
        try {
            const asset = await saveFeedbackScreenshotAsset(id, screenshotUpload, env);
            raw.screenshot = asset ? { ...raw.screenshot, ...asset } : null;
        } catch {
            raw.screenshot = null;
        }
    }
    const summary = buildLocalFeedbackSummary(raw);
    const record = {
        id,
        diagnosticsVersion: 2,
        createdAt: now.toISOString(),
        raw,
        summary,
        snapshot: raw.snapshot || null,
        client: raw.client || null,
        aiSummarized: false,
        email: {
            sent: false,
            skippedReason: 'missing_email_config',
        },
    };

    try {
        record.email = await sendFeedbackEmail(record, {
            env,
            mailer: options.mailer,
        });
    } catch (error) {
        record.email = {
            sent: false,
            error: redactSensitiveText(error.message || 'email_send_failed', 500),
        };
    }

    const logPath = getFeedbackLogPath(env);
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');

    return {
        id,
        aiSummarized: false,
        emailSent: Boolean(record.email?.sent),
        emailSkippedReason: record.email?.skippedReason || null,
        emailError: record.email?.error || null,
        record,
    };
}

export async function cleanupSeatingFeedback(options = {}) {
    const env = options.env || process.env;
    const now = options.now || new Date();
    const retentionDays = options.retentionDays ?? getFeedbackRetentionDays(env);
    if (!retentionDays || retentionDays <= 0) {
        return {
            skipped: true,
            retentionDays,
            removedRecords: 0,
            removedAssets: 0,
            keptRecords: 0,
        };
    }

    const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    const logPath = getFeedbackLogPath(env);
    const assetDir = getFeedbackAssetDir(env);
    let content = '';
    try {
        content = await readFile(logPath, 'utf8');
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        const removedAssets = await cleanupOrphanFeedbackAssets(assetDir, cutoffMs, new Set());
        return {
            skipped: false,
            retentionDays,
            removedRecords: 0,
            removedAssets,
            keptRecords: 0,
        };
    }

    const keptLines = [];
    const keptAssetNames = new Set();
    const expiredAssetNames = new Set();
    let removedRecords = 0;

    for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const record = parseFeedbackLine(line);
        if (!record || !isExpiredIsoDate(record.createdAt, cutoffMs)) {
            keptLines.push(line);
            const keptAssetName = collectFeedbackAssetName(record);
            if (keptAssetName) keptAssetNames.add(keptAssetName);
            continue;
        }

        removedRecords += 1;
        const expiredAssetName = collectFeedbackAssetName(record);
        if (expiredAssetName) expiredAssetNames.add(expiredAssetName);
    }

    if (removedRecords > 0) {
        const nextContent = keptLines.length ? `${keptLines.join('\n')}\n` : '';
        await writeFile(logPath, nextContent, 'utf8');
    }

    let removedAssets = 0;
    for (const assetName of expiredAssetNames) {
        const filePath = path.join(assetDir, assetName);
        if (await safeUnlink(filePath)) removedAssets += 1;
    }
    removedAssets += await cleanupOrphanFeedbackAssets(assetDir, cutoffMs, keptAssetNames);

    return {
        skipped: false,
        retentionDays,
        removedRecords,
        removedAssets,
        keptRecords: keptLines.length,
    };
}
