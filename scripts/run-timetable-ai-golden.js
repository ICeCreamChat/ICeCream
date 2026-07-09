#!/usr/bin/env node

import 'dotenv/config';
import { spawn } from 'node:child_process';

function hasText(value) {
    return Boolean(String(value || '').trim());
}

if (!hasText(process.env.DEEPSEEK_API_KEY) && !hasText(process.env.OPENAI_API_KEY)) {
    console.error('[timetable:ai-golden] missing API key: set DEEPSEEK_API_KEY or OPENAI_API_KEY in .env.');
    process.exitCode = 1;
} else {
    if (!hasText(process.env.DEEPSEEK_API_BASE) && !hasText(process.env.OPENAI_API_BASE)) {
        console.warn('[timetable:ai-golden] DEEPSEEK_API_BASE is not set; using default https://api.deepseek.com.');
    }

    const child = spawn(process.execPath, ['--test', 'test/timetable-ai-extraction.test.js'], {
        env: {
            ...process.env,
            TIMETABLE_RULE_AI_GOLDEN: '1'
        },
        stdio: 'inherit',
        windowsHide: true
    });

    child.on('exit', (code, signal) => {
        if (signal) {
            process.kill(process.pid, signal);
            return;
        }

        process.exitCode = code ?? 1;
    });

    child.on('error', (error) => {
        console.error('[timetable:ai-golden] failed:', error?.message || error);
        process.exitCode = 1;
    });
}
