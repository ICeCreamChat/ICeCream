import { constants } from 'node:fs';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import fetch from 'node-fetch';

import { gatewayPaths } from '../config/paths.js';
import { checkAiStatus } from './ai-status.js';
import { checkTimefoldStatus } from './seating-solver-bridge.js';
import { hasMailConfig } from './seating-feedback.js';
import { sanitizeDiagnosticValue, sanitizeLogLines } from './diagnostic-redaction.js';

const LOG_FILES = ['timefold.log', 'timefold.err.log', 'manim.err.log'];

function bool(value) {
    return Boolean(String(value ?? '').trim());
}

function numberOrDefault(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function getLogDir(env = process.env) {
    return env.DIAGNOSTIC_LOG_DIR || env.FEEDBACK_LOG_DIR || path.join(gatewayPaths.projectRoot, 'logs');
}

async function canWriteLogDir(logDir) {
    try {
        await mkdir(logDir, { recursive: true });
        await access(logDir, constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

async function readRecentLogs(logDir) {
    const result = {};
    await Promise.all(LOG_FILES.map(async filename => {
        const filePath = path.join(logDir, filename);
        try {
            const content = await readFile(filePath, 'utf8');
            result[filename] = sanitizeLogLines(content);
        } catch {
            result[filename] = [];
        }
    }));
    return result;
}

export async function buildSeatingDiagnostics({
    env = process.env,
    fetchImpl = fetch,
    now = new Date(),
} = {}) {
    const logDir = getLogDir(env);
    const [ai, timefold, feedbackLogWritable, recentLogs] = await Promise.all([
        checkAiStatus({ env, fetchImpl }).catch(() => ({
            online: false,
            label: 'ICeCream Offline',
            checkedAt: now.toISOString(),
            cached: false,
            reason: 'diagnostics_failed',
        })),
        checkTimefoldStatus({ env, fetchImpl }).catch(() => ({
            configured: bool(env.TIMEFOLD_SOLVER_URL),
            online: false,
            status: 'diagnostics_failed',
        })),
        canWriteLogDir(logDir),
        readRecentLogs(logDir),
    ]);

    const diagnostics = {
        diagnosticsVersion: 2,
        gateway: {
            status: 'ok',
            currentTime: now.toISOString(),
            nodeVersion: process.version,
            envMode: env.NODE_ENV || 'development',
        },
        ai: {
            online: Boolean(ai.online),
            label: ai.label || (ai.online ? 'ICeCream Online' : 'ICeCream Offline'),
            reason: ai.reason || (ai.online ? 'ok' : 'unknown'),
            checkedAt: ai.checkedAt || null,
            cached: Boolean(ai.cached),
            deepseekConfigured: bool(env.DEEPSEEK_API_BASE) && bool(env.DEEPSEEK_API_KEY),
        },
        timefold: {
            ...timefold,
            configured: Boolean(timefold.configured),
            online: Boolean(timefold.online),
            timeoutSeconds: numberOrDefault(env.TIMEFOLD_SOLVER_TIMEOUT, 8),
            fallbackReason: env.TIMEFOLD_LAST_FALLBACK_REASON || null,
        },
        services: {
            manimConfigured: bool(env.MANIM_API_BASE || env.MANIM_SERVICE_URL || env.MANIM_URL),
            feedbackEmailConfigured: hasMailConfig(env),
            feedbackLogWritable,
            logDirConfigured: bool(env.DIAGNOSTIC_LOG_DIR || env.FEEDBACK_LOG_DIR),
        },
        recentLogs,
    };

    return sanitizeDiagnosticValue(diagnostics, { maxLength: 120000, maxTextLength: 500 });
}
