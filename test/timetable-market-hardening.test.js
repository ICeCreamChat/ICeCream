import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
    recordConstraintMetric,
    recordConstraintMissSample,
    summarizeConstraintMetrics,
} from '../gateway/services/timetable-constraint-observability.js';

const execFileAsync = promisify(execFile);

async function tempLogEnv() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tt-constraint-logs-'));
    return { TIMETABLE_CONSTRAINT_LOG_DIR: dir };
}

test('constraint observability summarizes empty logs', async () => {
    const env = await tempLogEnv();
    const summary = await summarizeConstraintMetrics({ env });

    assert.equal(summary.totalEvents, 0);
    assert.equal(summary.parse.successRate, 0);
    assert.equal(summary.apply.successRate, 0);
    assert.equal(summary.solve.successRate, 0);
    assert.equal(summary.missSamples, 0);
});

test('constraint observability writes metrics and redacted miss samples', async () => {
    const env = await tempLogEnv();
    await recordConstraintMetric({ phase: 'parse', success: true, parseSource: 'ai_extract', requirementCount: 3, clarificationCount: 1 }, { env });
    await recordConstraintMetric({ phase: 'ai', success: true, requirementCount: 3, ai: { cacheHit: true, batchChunkCount: 2 } }, { env });
    await recordConstraintMetric({ phase: 'apply', success: true, appliedRuleCount: 2, appliedSemanticActionCount: 1 }, { env });
    await recordConstraintMetric({ phase: 'solve', success: false, solveSuccess: false, hardViolationCount: 1, softViolationCount: 2 }, { env });
    await recordConstraintMissSample({
        phase: 'parse',
        reason: 'no_requirements_extracted',
        input: '张老师 13812345678 zhang@example.com 周三不排。',
        warnings: ['无法识别'],
    }, { env });

    const summary = await summarizeConstraintMetrics({ env });
    assert.equal(summary.totalEvents, 4);
    assert.equal(summary.parse.successRate, 1);
    assert.equal(summary.parse.clarificationRate, 1);
    assert.equal(summary.ai.cacheHits, 1);
    assert.equal(summary.ai.batchCalls, 1);
    assert.equal(summary.apply.appliedRules, 2);
    assert.equal(summary.apply.appliedActions, 1);
    assert.equal(summary.solve.hardViolations, 1);
    assert.equal(summary.solve.softViolations, 2);
    assert.equal(summary.missSamples, 1);

    const metricRaw = await readFile(path.join(env.TIMETABLE_CONSTRAINT_LOG_DIR, 'constraint-metrics.jsonl'), 'utf8');
    const metricRows = metricRaw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    assert.ok(metricRows[0].parse_id);
    assert.equal(metricRows[0].input_type, '');
    assert.equal(metricRows[0].extracted_count, 3);
    assert.equal(metricRows[0].clarify_count, 1);
    assert.equal(metricRows[1].ai_used, true);
    assert.equal(metricRows[1].sentence_count, 0);
    assert.equal(metricRows[2].apply_count, 3);
    assert.equal(metricRows[3].hard_violations, 1);
    assert.equal(metricRows[3].soft_violations, 2);

    const missRaw = await readFile(path.join(env.TIMETABLE_CONSTRAINT_LOG_DIR, 'constraint-miss.jsonl'), 'utf8');
    assert.doesNotMatch(missRaw, /13812345678/);
    assert.doesNotMatch(missRaw, /zhang@example\.com/);
    assert.doesNotMatch(missRaw, /张老师/);
    assert.match(missRaw, /某老师/);
    assert.match(missRaw, /\[phone\]/);
    assert.match(missRaw, /\[email\]/);
});

test('constraint observability degrades when log path is not writable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tt-constraint-log-blocked-'));
    const blockedPath = path.join(dir, 'not-a-directory');
    await writeFile(blockedPath, 'blocked', 'utf8');
    const env = { TIMETABLE_CONSTRAINT_LOG_DIR: blockedPath };

    const metric = await recordConstraintMetric({ phase: 'parse', success: true, requirementCount: 1 }, { env });
    const miss = await recordConstraintMissSample({ phase: 'parse', input: '张老师 周三不排。' }, { env });

    assert.equal(metric.writeFailed, true);
    assert.match(metric.writeError, /EEXIST|ENOTDIR|not/i);
    assert.equal(miss.writeFailed, true);
    assert.match(miss.writeError, /EEXIST|ENOTDIR|not/i);
});

test('market release check exits non-zero when any required check is not pass', () => {
    const result = spawnSync(process.execPath, ['scripts/timetable-market-release-check.js', '--json'], {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: {
            ...process.env,
            TIMETABLE_RULE_AI_GOLDEN_REPORT: path.join(os.tmpdir(), `missing-ai-golden-${process.pid}-${Date.now()}.json`),
        },
    });
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.pass, false);
    assert.equal(result.status, 1);

    const corpus = payload.checks.find(item => item.label === 'market-language golden corpus contract');
    assert.equal(corpus?.status, 'pass');
    assert.match(corpus.detail, /205 rows/);
    assert.match(corpus.detail, /6\/6 categories/);
    assert.match(corpus.detail, /148 expected clauses/);
    assert.match(corpus.detail, /401 field checks/);

    const aiGolden = payload.checks.find(item => item.label === 'full AI golden report');
    assert.equal(aiGolden?.status, 'manual_required');
    assert.match(aiGolden.detail, /report unavailable|fullCorpus|promptVersion|corpusRows|corpusHash/);
});

test('AI golden runner loads DeepSeek config from local dotenv without leaking secrets', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'tt-ai-golden-dotenv-'));
    await writeFile(path.join(cwd, '.env'), [
        'DEEPSEEK_API_KEY=dotenv-deepseek-secret',
        'DEEPSEEK_API_BASE=https://api.deepseek.example',
        'DEEPSEEK_MODEL=deepseek-test-model',
        '',
    ].join('\n'), 'utf8');
    const result = spawnSync(process.execPath, [path.resolve('scripts/run-timetable-ai-golden.js'), '--check-config'], {
        cwd,
        encoding: 'utf8',
        env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            ComSpec: process.env.ComSpec,
        },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /deepseek-test-model/);
    assert.match(result.stdout, /"corpusRows":205/);
    assert.doesNotMatch(result.stdout, /dotenv-deepseek-secret/);
    assert.doesNotMatch(result.stderr, /dotenv-deepseek-secret/);
});

test('AI golden runner fails before external validation when API key is missing', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'tt-ai-golden-missing-key-'));
    await mkdir(path.join(cwd, 'test'), { recursive: true });
    await writeFile(path.join(cwd, 'test/timetable-ai-extraction.test.js'), [
        "import test from 'node:test';",
        "test('should not run without key', () => { throw new Error('runner spawned tests without key'); });",
        '',
    ].join('\n'), 'utf8');

    const result = spawnSync(process.execPath, [path.resolve('scripts/run-timetable-ai-golden.js')], {
        cwd,
        encoding: 'utf8',
        env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            ComSpec: process.env.ComSpec,
            DEEPSEEK_API_BASE: 'https://api.deepseek.example',
            DEEPSEEK_MODEL: 'deepseek-test-model',
        },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /DEEPSEEK_API_KEY|OPENAI_API_KEY/);
    assert.doesNotMatch(result.stderr, /runner spawned tests without key/);
});

test('constraint weekly stats script outputs empty and sample summaries', async () => {
    const emptyEnv = await tempLogEnv();
    const empty = await execFileAsync(process.execPath, [
        'scripts/timetable-constraint-weekly-stats.js',
        '--log-dir',
        emptyEnv.TIMETABLE_CONSTRAINT_LOG_DIR,
        '--since',
        '2000-01-01T00:00:00.000Z',
    ]);
    assert.equal(JSON.parse(empty.stdout).totalEvents, 0);

    const env = await tempLogEnv();
    await recordConstraintMetric({ phase: 'parse', success: true, requirementCount: 1 }, { env });
    await recordConstraintMetric({ phase: 'solve', success: true, solveSuccess: true }, { env });
    const sample = await execFileAsync(process.execPath, [
        'scripts/timetable-constraint-weekly-stats.js',
        '--log-dir',
        env.TIMETABLE_CONSTRAINT_LOG_DIR,
        '--since',
        '2000-01-01T00:00:00.000Z',
    ]);
    const summary = JSON.parse(sample.stdout);
    assert.equal(summary.totalEvents, 2);
    assert.equal(summary.parse.successRate, 1);
    assert.equal(summary.solve.successRate, 1);
});
