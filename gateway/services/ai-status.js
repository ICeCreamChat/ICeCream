import fetch from 'node-fetch';

export const DEFAULT_AI_STATUS_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_AI_STATUS_TIMEOUT_MS = 5000;

const aiStatusCache = {
    result: null,
    expiresAt: 0,
};

function asText(value) {
    return String(value ?? '').trim();
}

function hasConfiguredCredential(value) {
    const text = asText(value);
    return Boolean(text && !/your_|placeholder|changeme/i.test(text));
}

function normalizeApiBase(value) {
    return asText(value).replace(/\/+$/, '');
}

function buildStatus({ online, checkedAt, reason }) {
    return {
        online,
        label: online ? 'ICeCream Online' : 'ICeCream Offline',
        checkedAt,
        cached: false,
        reason,
    };
}

function cacheStatus(status, now, ttlMs) {
    aiStatusCache.result = { ...status, cached: false };
    aiStatusCache.expiresAt = now + ttlMs;
    return status;
}

export function clearAiStatusCache() {
    aiStatusCache.result = null;
    aiStatusCache.expiresAt = 0;
}

export async function checkAiStatus({
    env = process.env,
    fetchImpl = fetch,
    now = Date.now(),
    ttlMs = DEFAULT_AI_STATUS_TTL_MS,
    timeoutMs = DEFAULT_AI_STATUS_TIMEOUT_MS,
} = {}) {
    if (aiStatusCache.result && now < aiStatusCache.expiresAt) {
        return { ...aiStatusCache.result, cached: true };
    }

    const checkedAt = new Date(now).toISOString();
    const apiBase = normalizeApiBase(env.DEEPSEEK_API_BASE);
    const apiKey = asText(env.DEEPSEEK_API_KEY);

    if (!apiBase || !hasConfiguredCredential(apiKey)) {
        return cacheStatus(buildStatus({
            online: false,
            checkedAt,
            reason: 'not_configured',
        }), now, ttlMs);
    }

    try {
        const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(timeoutMs)
            : undefined;
        const response = await fetchImpl(`${apiBase}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: env.DEEPSEEK_CHAT_MODEL || env.DEEPSEEK_MODEL || 'deepseek-chat',
                messages: [{ role: 'user', content: 'ping' }],
                temperature: 0,
                max_tokens: 1,
                stream: false,
            }),
            signal,
        });

        return cacheStatus(buildStatus({
            online: Boolean(response?.ok),
            checkedAt,
            reason: response?.ok ? 'ok' : 'probe_failed',
        }), now, ttlMs);
    } catch {
        return cacheStatus(buildStatus({
            online: false,
            checkedAt,
            reason: 'probe_failed',
        }), now, ttlMs);
    }
}
