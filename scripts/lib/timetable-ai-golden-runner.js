import { performance } from 'node:perf_hooks';

import { AI_REQUIREMENT_PROMPT_VERSION } from '../../gateway/services/timetable-ai-prompts.js';
import { extractRequirementsWithAI } from '../../gateway/services/timetable-ai-extractor.js';
import {
    buildSourceRequirements,
    sourceInputRowsFromText,
} from '../../gateway/services/timetable-constraints/source-requirement.js';
import {
    aggregateCorpusScores,
    normalizeCorpusRow,
    scoreCorpusRow,
} from './timetable-market-language-corpus.js';
import { createMarketLanguageGoldenProject } from './timetable-market-language-evaluator.js';

const TRANSIENT_REASONS = new Set([
    'ai_extract_empty',
    'ai_extract_invalid_json',
    'ai_extract_timeout',
    'ai_extract_failed',
]);

function asList(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    return [value];
}

function positiveInteger(value, fallback = 1) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function wait(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

async function mapWithConcurrency(values = [], limit = 1, mapper) {
    const results = new Array(values.length);
    let cursor = 0;
    async function worker() {
        while (cursor < values.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await mapper(values[index], index);
        }
    }
    const workerCount = Math.min(values.length, Math.max(1, limit));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

function percentile95(values = []) {
    const sorted = values.filter(Number.isFinite).slice().sort((left, right) => left - right);
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function sourceRequirementsForRow(row = {}) {
    return buildSourceRequirements(
        sourceInputRowsFromText(row.text, { inputType: 'text', origin: 'user_input' }),
        { inputType: 'text', origin: 'user_input' },
    );
}

async function extractWithRetry({ extract, options, retryLimit, retryDelayMs }) {
    const attempts = [];
    let lastError = null;
    for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
        const started = performance.now();
        try {
            const result = await extract(options);
            attempts.push({ attempt, durationMs: performance.now() - started, ok: true });
            return { result, attempts };
        } catch (error) {
            lastError = error;
            const transient = TRANSIENT_REASONS.has(error?.reason);
            attempts.push({
                attempt,
                durationMs: performance.now() - started,
                ok: false,
                reason: error?.reason || 'ai_extract_failed',
                message: error?.message || String(error),
                transient,
            });
            if (!transient || attempt >= retryLimit) break;
            await wait(retryDelayMs * attempt);
        }
    }
    return { result: null, attempts, error: lastError };
}

function failureDetail(row, sourceRequirements, extraction) {
    const score = scoreCorpusRow(row, [], { semanticRequirements: [], sourceRequirements });
    return {
        id: row.id,
        text: row.text,
        score,
        durationMs: 0,
        attempts: extraction.attempts,
        error: {
            reason: extraction.error?.reason || 'ai_extract_failed',
            message: extraction.error?.message || String(extraction.error || 'AI extraction failed'),
        },
        model: '',
        promptVersion: AI_REQUIREMENT_PROMPT_VERSION,
    };
}

export async function runTimetableAiGolden({
    rows = [],
    corpusHash = '',
    corpusTotalRows = rows.length,
    selectedIds = [],
    project = null,
    env = process.env,
    extract = extractRequirementsWithAI,
    concurrency = 2,
    retryLimit = 3,
    retryDelayMs = 300,
    onProgress = null,
} = {}) {
    const normalizedRows = asList(rows).map(normalizeCorpusRow);
    if (!normalizedRows.length) throw new Error('AI golden corpus selection is empty.');
    const effectiveConcurrency = Math.min(4, positiveInteger(concurrency, 2));
    const effectiveRetryLimit = Math.min(5, positiveInteger(retryLimit, 3));
    const targetProject = project || createMarketLanguageGoldenProject();

    const details = await mapWithConcurrency(normalizedRows, effectiveConcurrency, async (row, index) => {
        const sourceRequirements = sourceRequirementsForRow(row);
        const extraction = await extractWithRetry({
            extract,
            retryLimit: effectiveRetryLimit,
            retryDelayMs: Math.max(0, Number(retryDelayMs) || 0),
            options: {
                project: targetProject,
                text: row.text,
                sourceRequirements,
                env: {
                    ...env,
                    TIMETABLE_RULE_AI_EXTRACT_TIMEOUT_MS: env.TIMETABLE_RULE_AI_EXTRACT_TIMEOUT_MS || '15000',
                },
            },
        });
        if (!extraction.result) {
            const detail = failureDetail(row, sourceRequirements, extraction);
            onProgress?.({ index: index + 1, total: normalizedRows.length, detail });
            return detail;
        }
        const result = extraction.result;
        const actualRequirements = asList(result.rawRequirements);
        const semanticRequirements = asList(result.semanticRequirements);
        const score = scoreCorpusRow(row, actualRequirements, { semanticRequirements, sourceRequirements });
        const successfulAttempt = extraction.attempts.findLast(attempt => attempt.ok);
        const detail = {
            id: row.id,
            text: row.text,
            score,
            durationMs: successfulAttempt?.durationMs || 0,
            attempts: extraction.attempts,
            error: null,
            model: result.model || '',
            promptVersion: result.promptVersion || AI_REQUIREMENT_PROMPT_VERSION,
        };
        onProgress?.({ index: index + 1, total: normalizedRows.length, detail });
        return detail;
    });

    const scores = details.map(detail => detail.score);
    const metrics = aggregateCorpusScores(scores);
    const misses = details.filter(detail => (
        detail.error
        || !detail.score.covered
        || detail.score.fields.misses.length
        || detail.score.sourcePreserved === false
        || detail.score.sourceAligned === false
    )).map(detail => ({
        id: detail.id,
        error: detail.error,
        intentMisses: detail.score.intentMisses,
        fieldMisses: detail.score.fields.misses,
        sourcePreserved: detail.score.sourcePreserved,
        sourceAligned: detail.score.sourceAligned,
    }));
    const models = [...new Set(details.map(detail => detail.model).filter(Boolean))];
    const promptVersions = [...new Set(details.map(detail => detail.promptVersion).filter(Boolean))];
    const retryCount = details.reduce((total, detail) => total + Math.max(0, detail.attempts.length - 1), 0);
    const p95Ms = Math.round(percentile95(details.filter(detail => !detail.error).map(detail => detail.durationMs)));
    const fullCorpus = normalizedRows.length === corpusTotalRows && asList(selectedIds).length === 0;
    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        model: models.length === 1 ? models[0] : models,
        promptVersion: promptVersions.length === 1 ? promptVersions[0] : promptVersions,
        corpusHash,
        corpusRows: normalizedRows.length,
        corpusTotalRows,
        fullCorpus,
        selectedIds: asList(selectedIds),
        concurrency: effectiveConcurrency,
        retryLimit: effectiveRetryLimit,
        retryCount,
        timeoutMs: positiveInteger(env.TIMETABLE_RULE_AI_EXTRACT_TIMEOUT_MS, 15000),
        coverage: metrics.coverage,
        fieldAccuracy: metrics.fieldAccuracy,
        sourcePreservationRate: metrics.sourcePreservationRate,
        sourceAlignmentRate: metrics.sourceAlignmentRate,
        p95Ms,
        misses,
        categoryMetrics: metrics.categoryMetrics,
        details,
    };
}

export function timetableAiGoldenGateFailures(report = {}, {
    minimumRows = 200,
    minimumCoverage = 0.95,
    minimumFieldAccuracy = 0.98,
    maximumP95Ms = 15_000,
} = {}) {
    const failures = [];
    if (report.fullCorpus && report.corpusRows < minimumRows) failures.push(`full corpus rows ${report.corpusRows} < ${minimumRows}`);
    if (report.coverage < minimumCoverage) failures.push(`coverage ${report.coverage} < ${minimumCoverage}`);
    if (report.fieldAccuracy < minimumFieldAccuracy) failures.push(`fieldAccuracy ${report.fieldAccuracy} < ${minimumFieldAccuracy}`);
    if (report.sourcePreservationRate !== 1) failures.push(`sourcePreservationRate ${report.sourcePreservationRate} != 1`);
    if (report.sourceAlignmentRate !== 1) failures.push(`sourceAlignmentRate ${report.sourceAlignmentRate} != 1`);
    if (report.p95Ms > maximumP95Ms) failures.push(`p95Ms ${report.p95Ms} > ${maximumP95Ms}`);
    return failures;
}

export function renderTimetableAiGoldenMarkdown(report = {}) {
    const percent = value => `${(Number(value || 0) * 100).toFixed(2)}%`;
    const lines = [
        '# Timetable AI Golden Report',
        '',
        `- generatedAt: ${report.generatedAt || ''}`,
        `- model: \`${Array.isArray(report.model) ? report.model.join(', ') : report.model || ''}\``,
        `- promptVersion: \`${Array.isArray(report.promptVersion) ? report.promptVersion.join(', ') : report.promptVersion || ''}\``,
        `- corpusHash: \`${report.corpusHash || ''}\``,
        `- corpus rows: ${report.corpusRows || 0}/${report.corpusTotalRows || 0}`,
        `- full corpus: ${Boolean(report.fullCorpus)}`,
        `- concurrency/retry limit/retries: ${report.concurrency || 0}/${report.retryLimit || 0}/${report.retryCount || 0}`,
        `- semantic coverage: ${percent(report.coverage)}`,
        `- field accuracy: ${percent(report.fieldAccuracy)}`,
        `- source preservation: ${percent(report.sourcePreservationRate)}`,
        `- source alignment: ${percent(report.sourceAlignmentRate)}`,
        `- P95: ${report.p95Ms || 0}ms`,
        `- misses: ${(report.misses || []).length}`,
        '',
        '## Misses',
        '',
    ];
    if (!(report.misses || []).length) lines.push('- None');
    else report.misses.forEach(miss => lines.push(`- **${miss.id}**: ${JSON.stringify(miss)}`));
    return `${lines.join('\n')}\n`;
}
