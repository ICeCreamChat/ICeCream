import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateLocalMarketLanguageCorpus } from '../scripts/lib/timetable-market-language-evaluator.js';
import { loadConstraintCorpus } from '../scripts/lib/timetable-market-language-corpus.js';

let localCorpusReportPromise;

function loadLocalCorpusReport() {
    if (!localCorpusReportPromise) {
        localCorpusReportPromise = loadConstraintCorpus().then(async corpus => ({
            corpus,
            report: await evaluateLocalMarketLanguageCorpus({ rows: corpus.rows }),
        }));
    }
    return localCorpusReportPromise;
}

test('local parser preserves exactly one top-level source for every corpus row and retains clarification states', async () => {
    const { corpus, report } = await loadLocalCorpusReport();

    assert.equal(report.metrics.rows, 205);
    assert.equal(report.metrics.sourcePreservationRate, 1);
    assert.deepEqual(report.details.filter(item => item.sourceCount !== 1).map(item => item.id), []);

    const clarificationIds = new Set(corpus.rows.filter(row => row.needsClarification).map(row => row.id));
    const clarificationFailures = report.details
        .filter(item => clarificationIds.has(item.id) && !item.clarificationOk)
        .map(item => item.id);
    assert.deepEqual(clarificationFailures, []);

    const unrecognizedIds = new Set(corpus.rows.filter(row => row.unrecognized).map(row => row.id));
    const disappeared = report.details.filter(item => unrecognizedIds.has(item.id)
        && item.machineRuleCount === 0
        && !item.actualIntents.some(intent => intent === 'unrecognized' || intent === 'unknown')
        && !item.warnings.length).map(item => item.id);
    assert.deepEqual(disappeared, []);

    for (const [category, metrics] of Object.entries(report.metrics.categoryMetrics)) {
        assert.equal(metrics.rows, 15, category);
        assert.equal(metrics.sourcePreserved, 15, category);
    }
});

test('local parser satisfies every classified market-language intent and field truth', async () => {
    const { report } = await loadLocalCorpusReport();

    for (const [category, metrics] of Object.entries(report.metrics.categoryMetrics)) {
        const failureIds = metrics.failures.map(item => item.id);
        assert.equal(metrics.covered, metrics.rows, category + ' intent failures: ' + failureIds.join(', '));
        assert.equal(metrics.fieldHits, metrics.fieldTotal, category + ' field failures: ' + failureIds.join(', '));
        assert.deepEqual(failureIds, [], category);
    }
});

test('market-language capability routing stays canonical and unsupported IR never owns machine rules', async () => {
    const { report } = await loadLocalCorpusReport();
    const nestedLegacyCapabilities = report.details.flatMap(item => item.capabilityIds)
        .filter(capabilityId => capabilityId.startsWith('legacy.legacy.'));
    const unsupportedMachineRules = report.details.flatMap(item => item.unsupportedIrMachineRules);

    assert.deepEqual(nestedLegacyCapabilities, []);
    assert.deepEqual(unsupportedMachineRules, []);
});
