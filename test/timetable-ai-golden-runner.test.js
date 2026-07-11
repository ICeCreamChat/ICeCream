import test from 'node:test';
import assert from 'node:assert/strict';

import {
    renderTimetableAiGoldenMarkdown,
    runTimetableAiGolden,
    timetableAiGoldenGateFailures,
} from '../scripts/lib/timetable-ai-golden-runner.js';

const rows = [{
    id: 'g001',
    text: '数学尽量上午',
    primaryCategory: 'colloquial',
    categories: ['colloquial'],
    expectedIntents: ['subject_morning'],
    expectedClauses: [{
        intent: 'subject_morning',
        targetKind: 'subject',
        targetNames: ['数学'],
        time: { dayPart: 'morning' },
        strength: 'soft',
    }],
}, {
    id: 'g002',
    text: '今天天气怎么样',
    unrecognized: true,
    expectedIntents: [],
    expectedClauses: [],
}];

test('AI golden runner uses unified truth, retries transient failures and records full metadata', async () => {
    let calls = 0;
    const report = await runTimetableAiGolden({
        rows,
        corpusHash: 'sha256:test-corpus',
        corpusTotalRows: 2,
        concurrency: 2,
        retryLimit: 2,
        retryDelayMs: 0,
        env: { TIMETABLE_RULE_AI_EXTRACT_TIMEOUT_MS: '12345' },
        extract: async ({ text, sourceRequirements }) => {
            calls += 1;
            if (text.includes('数学') && calls === 1) {
                const error = new Error('temporary timeout');
                error.reason = 'ai_extract_timeout';
                throw error;
            }
            const source = sourceRequirements[0];
            return {
                model: 'mock-golden-model',
                promptVersion: 'timetable_ai_requirement_extract_v5',
                rawRequirements: text.includes('数学') ? [{
                    sourceId: source.sourceId,
                    textHash: source.textHash,
                    intent: 'subject_morning',
                    targetKind: 'subject',
                    targetNames: ['数学'],
                    time: { dayPart: 'morning' },
                    strength: 'soft',
                }] : [],
                semanticRequirements: [],
            };
        },
    });

    assert.equal(report.fullCorpus, true);
    assert.equal(report.model, 'mock-golden-model');
    assert.equal(report.promptVersion, 'timetable_ai_requirement_extract_v5');
    assert.equal(report.corpusHash, 'sha256:test-corpus');
    assert.equal(report.corpusRows, 2);
    assert.equal(report.retryCount, 1);
    assert.equal(report.timeoutMs, 12345);
    assert.equal(report.coverage, 1);
    assert.equal(report.fieldAccuracy, 1);
    assert.equal(report.sourcePreservationRate, 1);
    assert.equal(report.sourceAlignmentRate, 1);
    assert.deepEqual(report.misses, []);
    assert.deepEqual(timetableAiGoldenGateFailures(report, { minimumRows: 2 }), []);
    assert.match(renderTimetableAiGoldenMarkdown(report), /mock-golden-model/);
    assert.match(renderTimetableAiGoldenMarkdown(report), /source alignment: 100\.00%/);
});

test('AI golden runner reports identity mismatches and permanent extraction failures without dropping rows', async () => {
    const report = await runTimetableAiGolden({
        rows,
        corpusHash: 'sha256:test-corpus',
        corpusTotalRows: 2,
        retryLimit: 2,
        retryDelayMs: 0,
        extract: async ({ text }) => {
            if (!text.includes('数学')) {
                const error = new Error('invalid response');
                error.reason = 'invalid_source_identity';
                throw error;
            }
            return {
                model: 'mock-golden-model',
                promptVersion: 'timetable_ai_requirement_extract_v5',
                rawRequirements: [{
                    sourceId: 'invented-source',
                    textHash: 'invented-hash',
                    intent: 'subject_morning',
                    targetKind: 'subject',
                    targetNames: ['数学'],
                    time: { dayPart: 'morning' },
                    strength: 'soft',
                }],
                semanticRequirements: [],
            };
        },
    });

    assert.equal(report.details.length, 2);
    assert.equal(report.sourcePreservationRate, 1);
    assert.equal(report.sourceAlignmentRate, 0.5);
    assert.equal(report.misses.length, 2);
    assert.ok(timetableAiGoldenGateFailures(report, { minimumRows: 2 }).some(item => item.includes('sourceAlignmentRate')));
});
