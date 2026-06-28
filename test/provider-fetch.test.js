import assert from 'node:assert/strict';
import test from 'node:test';

import {
    fetchJsonWithTimeout,
    fetchWithBudget,
    isProviderFetchError,
} from '../services/provider-fetch.js';

test('fetchJsonWithTimeout aborts provider calls within the configured budget', async () => {
    const hangingFetch = (_url, init = {}) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted by test signal');
            error.name = 'AbortError';
            reject(error);
        });
    });

    await assert.rejects(
        fetchJsonWithTimeout('https://provider.invalid/slow', {
            fetchImpl: hangingFetch,
            timeoutMs: 20,
            provider: 'test-provider',
        }),
        error => {
            assert.equal(isProviderFetchError(error), true);
            assert.equal(error.reason, 'provider_timeout');
            assert.equal(error.provider, 'test-provider');
            return true;
        }
    );
});

test('fetchWithBudget classifies non-2xx provider responses', async () => {
    await assert.rejects(
        fetchWithBudget('https://provider.invalid/bad', {
            fetchImpl: async () => ({ ok: false, status: 502 }),
            timeoutMs: 100,
            provider: 'test-provider',
        }),
        error => {
            assert.equal(isProviderFetchError(error), true);
            assert.equal(error.reason, 'provider_bad_response');
            assert.equal(error.statusCode, 502);
            return true;
        }
    );
});
