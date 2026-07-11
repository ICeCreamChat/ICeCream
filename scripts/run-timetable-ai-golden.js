#!/usr/bin/env node

import 'dotenv/config';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadConstraintCorpus } from './lib/timetable-market-language-corpus.js';
import {
    renderTimetableAiGoldenMarkdown,
    runTimetableAiGolden,
    timetableAiGoldenGateFailures,
} from './lib/timetable-ai-golden-runner.js';

function hasText(value) {
    return Boolean(String(value || '').trim());
}

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function selectedIdsFromCli() {
    return process.argv.slice(2)
        .flatMap(value => String(value || '').split(','))
        .map(value => value.trim())
        .filter(Boolean);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');

async function main() {
    if (!hasText(process.env.DEEPSEEK_API_KEY) && !hasText(process.env.OPENAI_API_KEY)) {
        throw new Error('missing API key: set DEEPSEEK_API_KEY or OPENAI_API_KEY in .env');
    }
    if (!hasText(process.env.DEEPSEEK_API_BASE) && !hasText(process.env.OPENAI_API_BASE)) {
        console.warn('[timetable:ai-golden] API base is not set; using the extractor default.');
    }

    const corpusPath = process.env.TIMETABLE_RULE_AI_GOLDEN_CORPUS
        || path.join(repositoryRoot, 'test/fixtures/constraint-corpus.jsonl');
    const corpus = await loadConstraintCorpus(corpusPath);
    if (corpus.errors.length) throw new Error(corpus.errors.join('\n'));
    if (process.argv.includes('--check-config')) {
        console.log(JSON.stringify({
            configured: true,
            model: process.env.DEEPSEEK_MODEL || process.env.OPENAI_MODEL || 'deepseek-chat',
            corpusRows: corpus.rows.length,
            corpusHash: corpus.hash,
        }));
        return;
    }
    const cliIds = selectedIdsFromCli();
    const requestedIds = cliIds.length
        ? cliIds
        : String(process.env.TIMETABLE_RULE_AI_GOLDEN_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
    const requestedIdSet = new Set(requestedIds);
    const unknownIds = requestedIds.filter(id => !corpus.rows.some(row => row.id === id));
    if (unknownIds.length) throw new Error(`unknown golden case ids: ${unknownIds.join(', ')}`);
    const rows = requestedIds.length ? corpus.rows.filter(row => requestedIdSet.has(row.id)) : corpus.rows;
    const concurrency = Math.min(4, positiveInteger(process.env.TIMETABLE_RULE_AI_GOLDEN_CONCURRENCY, 2));
    const retryLimit = Math.min(5, positiveInteger(process.env.TIMETABLE_RULE_AI_GOLDEN_RETRIES, 3));

    const report = await runTimetableAiGolden({
        rows,
        corpusHash: corpus.hash,
        corpusTotalRows: corpus.rows.length,
        selectedIds: requestedIds,
        env: process.env,
        concurrency,
        retryLimit,
        retryDelayMs: positiveInteger(process.env.TIMETABLE_RULE_AI_GOLDEN_RETRY_DELAY_MS, 300),
        onProgress: ({ index, total, detail }) => {
            const state = detail.error ? `error:${detail.error.reason}` : (detail.score.covered ? 'covered' : 'miss');
            console.log(`[timetable:ai-golden] ${index}/${total} ${detail.id} ${state} ${Math.round(detail.durationMs)}ms`);
        },
    });
    const jsonPath = path.resolve(process.env.TIMETABLE_RULE_AI_GOLDEN_REPORT || '.tmp-timetable-ai-golden-latest.json');
    const markdownPath = path.resolve(process.env.TIMETABLE_RULE_AI_GOLDEN_MARKDOWN_REPORT || '.tmp-timetable-ai-golden-latest.md');
    await Promise.all([
        writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
        writeFile(markdownPath, renderTimetableAiGoldenMarkdown(report), 'utf8'),
    ]);

    const failures = timetableAiGoldenGateFailures(report);
    console.log(JSON.stringify({
        reportPath: jsonPath,
        markdownReportPath: markdownPath,
        model: report.model,
        promptVersion: report.promptVersion,
        corpusHash: report.corpusHash,
        corpusRows: report.corpusRows,
        fullCorpus: report.fullCorpus,
        coverage: report.coverage,
        fieldAccuracy: report.fieldAccuracy,
        sourcePreservationRate: report.sourcePreservationRate,
        sourceAlignmentRate: report.sourceAlignmentRate,
        p95Ms: report.p95Ms,
        misses: report.misses.length,
        gateFailures: failures,
    }, null, 2));
    if (failures.length) throw new Error(`AI golden gates failed: ${failures.join('; ')}`);
}

main().catch(error => {
    console.error('[timetable:ai-golden] failed:', error?.message || error);
    process.exitCode = 1;
});
