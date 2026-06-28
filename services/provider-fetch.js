import fetch from 'node-fetch';

export const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;

export class ProviderFetchError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'ProviderFetchError';
        this.reason = details.reason || 'provider_unavailable';
        this.provider = details.provider || 'provider';
        this.statusCode = details.statusCode || null;
        this.cause = details.cause;
        this.expose = false;
    }
}

export function readProviderTimeoutMs(value, fallback = DEFAULT_PROVIDER_TIMEOUT_MS) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.max(100, Math.min(Math.floor(number), 300_000));
}

function createTimeoutSignal(timeoutMs) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(timeoutMs);
    }
    const controller = new AbortController();
    setTimeout(() => controller.abort(), timeoutMs).unref?.();
    return controller.signal;
}

function classifyFetchError(error) {
    const message = String(error?.message || '');
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || /abort|timeout|timed out/i.test(message)) {
        return 'provider_timeout';
    }
    return 'provider_unavailable';
}

function buildProviderError(reason, provider, options = {}) {
    const readable = {
        provider_timeout: `${provider} request timed out`,
        provider_bad_response: `${provider} returned an invalid response`,
        provider_unavailable: `${provider} is unavailable`,
    }[reason] || `${provider} request failed`;
    return new ProviderFetchError(readable, {
        reason,
        provider,
        statusCode: options.statusCode,
        cause: options.cause,
    });
}

export function isProviderFetchError(error) {
    return error instanceof ProviderFetchError || error?.name === 'ProviderFetchError';
}

export async function fetchWithBudget(url, options = {}) {
    const {
        fetchImpl = fetch,
        timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
        provider = 'provider',
        signal,
        ...init
    } = options;
    const finalSignal = signal || createTimeoutSignal(readProviderTimeoutMs(timeoutMs));

    let response;
    try {
        response = await fetchImpl(url, {
            ...init,
            signal: finalSignal,
        });
    } catch (error) {
        throw buildProviderError(classifyFetchError(error), provider, { cause: error });
    }

    if (!response?.ok) {
        throw buildProviderError('provider_bad_response', provider, {
            statusCode: response?.status || null,
        });
    }

    return response;
}

export async function fetchJsonWithTimeout(url, options = {}) {
    const response = await fetchWithBudget(url, options);
    try {
        return await response.json();
    } catch (error) {
        throw buildProviderError('provider_bad_response', options.provider || 'provider', { cause: error });
    }
}

export async function fetchTextWithTimeout(url, options = {}) {
    const response = await fetchWithBudget(url, options);
    try {
        return await response.text();
    } catch (error) {
        throw buildProviderError('provider_bad_response', options.provider || 'provider', { cause: error });
    }
}
