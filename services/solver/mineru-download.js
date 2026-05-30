/**
 * Shared MinerU result package downloader.
 * Keeps proxy handling local to MinerU CDN downloads and avoids leaking secrets.
 */

import dns from 'node:dns/promises';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const DEFAULT_BASE_DELAY_MS = 800;
const DEFAULT_DOWNLOAD_BUDGET_MS = 35000;
const DEFAULT_DOWNLOAD_RETRIES = 2;
const DEFAULT_FAILURE_COOLDOWN_MS = 600000;

const availabilityState = {
    unavailableUntilMs: 0,
    reason: '',
    lastError: '',
    lastFailureAtMs: 0,
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function readPositiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getNowMs(options = {}) {
    return Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
}

function normalizeFailureReason(errorOrReason) {
    if (typeof errorOrReason === 'string') return errorOrReason;
    if (errorOrReason?.code === 'MINERU_CDN_FAKE_IP_NO_PROXY') return 'fake-ip-no-proxy';

    const message = errorOrReason?.message || '';
    if (/Fake-IP|198\.18|198\.19/i.test(message)) return 'fake-ip-no-proxy';
    if (/TLS|secure|socket|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network/i.test(message)) return 'network';
    if (/timeout|timed out|abort/i.test(message)) return 'timeout';
    if (/HTTP \d+/.test(message)) return 'http';
    return 'download-failed';
}

export function getMineruDownloadProxy(env = process.env) {
    return (
        env.MINERU_DOWNLOAD_PROXY ||
        env.HTTPS_PROXY ||
        env.https_proxy ||
        env.HTTP_PROXY ||
        env.http_proxy ||
        env.ALL_PROXY ||
        env.all_proxy ||
        ''
    ).trim();
}

export function isFakeIpAddress(address = '') {
    const parts = String(address).split('.').map(part => Number(part));
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) {
        return false;
    }

    return parts[0] === 198 && (parts[1] === 18 || parts[1] === 19);
}

export function resolveMineruDownloadPolicy(env = process.env, options = {}) {
    const budgetMs = readPositiveNumber(options.budgetMs ?? env.MINERU_DOWNLOAD_BUDGET_MS, DEFAULT_DOWNLOAD_BUDGET_MS);
    const maxAttempts = Math.max(
        1,
        Math.floor(readPositiveNumber(options.maxAttempts ?? env.MINERU_DOWNLOAD_RETRIES, DEFAULT_DOWNLOAD_RETRIES)),
    );
    const timeoutFallback = Math.max(1000, Math.floor(budgetMs / maxAttempts));
    const timeoutMs = readPositiveNumber(options.timeoutMs ?? env.MINERU_DOWNLOAD_TIMEOUT_MS, timeoutFallback);
    const baseDelayMs = Number.isFinite(Number(options.baseDelayMs))
        ? Number(options.baseDelayMs)
        : DEFAULT_BASE_DELAY_MS;
    const cooldownMs = readPositiveNumber(options.cooldownMs ?? env.MINERU_FAILURE_COOLDOWN_MS, DEFAULT_FAILURE_COOLDOWN_MS);

    return {
        budgetMs,
        maxAttempts,
        timeoutMs: Math.min(timeoutMs, budgetMs),
        baseDelayMs,
        cooldownMs,
    };
}

export function getMineruDownloadAvailability(options = {}) {
    const nowMs = getNowMs(options);
    if (availabilityState.unavailableUntilMs > nowMs) {
        return {
            available: false,
            reason: availabilityState.reason,
            lastError: availabilityState.lastError,
            lastFailureAtMs: availabilityState.lastFailureAtMs,
            retryAtMs: availabilityState.unavailableUntilMs,
        };
    }

    return {
        available: true,
        reason: '',
        lastError: '',
        lastFailureAtMs: availabilityState.lastFailureAtMs,
        retryAtMs: 0,
    };
}

export function canAttemptMineruDownload(options = {}) {
    return getMineruDownloadAvailability(options).available;
}

export function markMineruDownloadFailure(errorOrReason, options = {}) {
    const env = options.env || process.env;
    const nowMs = getNowMs(options);
    const policy = resolveMineruDownloadPolicy(env, options);
    const reason = normalizeFailureReason(errorOrReason);
    availabilityState.unavailableUntilMs = nowMs + policy.cooldownMs;
    availabilityState.reason = reason;
    availabilityState.lastError = errorOrReason?.message || String(errorOrReason || reason);
    availabilityState.lastFailureAtMs = nowMs;
    return getMineruDownloadAvailability({ nowMs });
}

export function markMineruDownloadSuccess() {
    availabilityState.unavailableUntilMs = 0;
    availabilityState.reason = '';
    availabilityState.lastError = '';
}

export function resetMineruDownloadAvailability() {
    availabilityState.unavailableUntilMs = 0;
    availabilityState.reason = '';
    availabilityState.lastError = '';
    availabilityState.lastFailureAtMs = 0;
}

function classifyDownloadError(error) {
    const message = error?.message || '';
    if (error?.name === 'AbortError' || /abort|timeout|timed out/i.test(message)) {
        return 'timeout';
    }
    if (/TLS|secure|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network/i.test(message)) {
        return 'network';
    }
    if (/HTTP \d+/.test(message)) {
        return 'http';
    }
    return 'unknown';
}

function createFetchInit(timeoutMs, agent) {
    const init = {
        signal: AbortSignal.timeout(timeoutMs),
    };
    if (agent) {
        init.agent = agent;
    }
    return init;
}

async function resolveCdnAddresses(zipUrl, lookupImpl) {
    let hostname;
    try {
        hostname = new URL(zipUrl).hostname;
    } catch {
        return [];
    }

    try {
        const result = await lookupImpl(hostname, { all: true });
        const results = Array.isArray(result) ? result : [result];
        return results.map(item => item?.address).filter(Boolean);
    } catch (error) {
        return [];
    }
}

export async function shouldSkipMineruDownloadForFakeIp(zipUrl, options = {}) {
    const env = options.env || process.env;
    if (getMineruDownloadProxy(env)) {
        return false;
    }

    const lookupImpl = options.lookupImpl || dns.lookup;
    const addresses = await resolveCdnAddresses(zipUrl, lookupImpl);
    return addresses.some(isFakeIpAddress);
}

export async function fetchMineruZipWithRetry(zipUrl, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const env = options.env || process.env;
    const logger = options.logger || console;
    const nowMs = getNowMs(options);
    const availability = getMineruDownloadAvailability({ nowMs });
    if (!availability.available) {
        const error = new Error(`MinerU download is in cooldown until ${availability.retryAtMs}`);
        error.code = 'MINERU_DOWNLOAD_COOLDOWN';
        error.reason = availability.reason;
        throw error;
    }

    const policy = resolveMineruDownloadPolicy(env, options);
    const maxAttempts = policy.maxAttempts;
    const timeoutMs = policy.timeoutMs;
    const baseDelayMs = policy.baseDelayMs;
    const proxyUrl = getMineruDownloadProxy(env);
    const proxyAgentFactory = options.proxyAgentFactory || (url => new HttpsProxyAgent(url));
    const agent = proxyUrl ? proxyAgentFactory(proxyUrl) : undefined;

    if (!proxyUrl && await shouldSkipMineruDownloadForFakeIp(zipUrl, options)) {
        const error = new Error('MinerU CDN resolved to Fake-IP (198.18.x.x) and no download proxy is configured');
        error.code = 'MINERU_CDN_FAKE_IP_NO_PROXY';
        markMineruDownloadFailure(error, { ...options, env, nowMs });
        logger.warn?.('[MinerU] 结果包 CDN 疑似 Fake-IP 且未配置代理，已跳过下载并降级到后续识别层');
        throw error;
    }

    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await fetchImpl(zipUrl, createFetchInit(timeoutMs, agent));

            if (!response.ok) {
                throw new Error(`MinerU zip HTTP ${response.status}`);
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            markMineruDownloadSuccess();
            return buffer;
        } catch (error) {
            lastError = error;
            const category = classifyDownloadError(error);
            logger.warn?.(`[MinerU] result zip download failed (${attempt}/${maxAttempts}, ${category}): ${error.message}`);
            if (attempt < maxAttempts && baseDelayMs > 0) {
                await delay(baseDelayMs * Math.pow(2, attempt - 1));
            }
        }
    }

    const error = lastError || new Error('MinerU zip download failed');
    markMineruDownloadFailure(error, { ...options, env, nowMs });
    throw error;
}

export default {
    canAttemptMineruDownload,
    fetchMineruZipWithRetry,
    getMineruDownloadAvailability,
    getMineruDownloadProxy,
    isFakeIpAddress,
    markMineruDownloadFailure,
    markMineruDownloadSuccess,
    resetMineruDownloadAvailability,
    resolveMineruDownloadPolicy,
    shouldSkipMineruDownloadForFakeIp,
};
