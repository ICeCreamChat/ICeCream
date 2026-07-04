import assert from 'node:assert/strict';
import test from 'node:test';

import { requestTimetable } from '../public/js/tools/timetable/api.js';

test('timetable API wrapper reports non-JSON responses without leaking HTML parser errors', async () => {
    const fetchImpl = async () => new Response('<!DOCTYPE html><title>Fallback</title>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });

    await assert.rejects(
        () => requestTimetable('/rule-review/parse', { method: 'POST', body: new FormData(), fetch: fetchImpl }),
        error => {
            assert.equal(error.status, 200);
            assert.doesNotMatch(error.message, /Unexpected token|<!DOCTYPE/i);
            assert.match(error.message, /非 JSON|接口|服务/);
            return true;
        },
    );
});
