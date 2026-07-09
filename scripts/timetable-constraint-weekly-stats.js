#!/usr/bin/env node

import { summarizeConstraintMetrics } from '../gateway/services/timetable-constraint-observability.js';

function argValue(name, fallback = '') {
    const exact = process.argv.find(item => item.startsWith(`${name}=`));
    if (exact) return exact.slice(name.length + 1);
    const index = process.argv.indexOf(name);
    if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
    return fallback;
}

function defaultSince() {
    const date = new Date();
    date.setDate(date.getDate() - 7);
    return date.toISOString();
}

const logDir = argValue('--log-dir', '');
const since = argValue('--since', defaultSince());

summarizeConstraintMetrics({
    env: {
        ...process.env,
        ...(logDir ? { TIMETABLE_CONSTRAINT_LOG_DIR: logDir } : {}),
    },
    since,
}).then(summary => {
    console.log(JSON.stringify(summary, null, 2));
}).catch(error => {
    console.error('[timetable-constraint-weekly-stats] failed:', error?.message || error);
    process.exitCode = 1;
});
