#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { evaluateLocalMarketLanguageCorpus } from './lib/timetable-market-language-evaluator.js';

function option(name, fallback = '') {
    const prefix = `${name}=`;
    const direct = process.argv.find(value => value.startsWith(prefix));
    if (direct) return direct.slice(prefix.length);
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function percentage(value) {
    return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function markdownReport(report) {
    const lines = [
        '# Timetable Market Language Local Corpus Report',
        '',
        `- generatedAt: ${report.generatedAt}`,
        `- corpusHash: \`${report.corpusHash}\``,
        `- rows: ${report.metrics.rows}`,
        `- semantic coverage: ${percentage(report.metrics.coverage)}`,
        `- field accuracy: ${percentage(report.metrics.fieldAccuracy)}`,
        `- source preservation: ${percentage(report.metrics.sourcePreservationRate)}`,
        `- source alignment: ${percentage(report.metrics.sourceAlignmentRate)}`,
        '',
        '## Category metrics',
        '',
        '| category | rows | coverage | field accuracy | source preservation | source alignment | clarification safety | failures |',
        '|---|---:|---:|---:|---:|---:|---:|---:|',
    ];
    for (const [category, metric] of Object.entries(report.metrics.categoryMetrics)) {
        lines.push(`| ${category} | ${metric.rows} | ${percentage(metric.covered / Math.max(1, metric.rows))} | ${percentage(metric.fieldHits / Math.max(1, metric.fieldTotal))} | ${percentage(metric.sourcePreserved / Math.max(1, metric.sourceChecked))} | ${percentage(metric.sourceAligned / Math.max(1, metric.sourceChecked))} | ${percentage(metric.clarificationSafe / Math.max(1, metric.clarificationRows))} | ${metric.failures.length} |`);
    }
    lines.push('', '## Failure samples', '');
    const failures = report.details.filter(item => !item.covered || item.fieldMisses.length || !item.sourcePreserved || !item.sourceAligned);
    for (const item of failures) {
        lines.push(`- **${item.id}** (${item.primaryCategory || 'legacy'}): ${item.text}`);
        if (item.intentMisses.length) lines.push(`  - intent misses: ${item.intentMisses.join(', ')}`);
        if (item.fieldMisses.length) lines.push(`  - field misses: ${item.fieldMisses.slice(0, 8).map(miss => `${miss.intent}:${miss.field}`).join(', ')}`);
        if (!item.sourcePreserved || !item.sourceAligned) lines.push(`  - source: preserved=${item.sourcePreserved}, aligned=${item.sourceAligned}, count=${item.sourceCount}`);
    }
    return `${lines.join('\n')}\n`;
}

const prefix = option('--output-prefix', '.tmp-timetable-market-language-local');
const report = await evaluateLocalMarketLanguageCorpus({
    onProgress: ({ index, total }) => {
        if (index % 25 === 0 || index === total) console.error(`[market-language-local] ${index}/${total}`);
    },
});
const jsonPath = path.resolve(`${prefix}.json`);
const markdownPath = path.resolve(`${prefix}.md`);
await mkdir(path.dirname(jsonPath), { recursive: true });
await mkdir(path.dirname(markdownPath), { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(markdownPath, markdownReport(report));
console.log(JSON.stringify({
    jsonPath,
    markdownPath,
    rows: report.metrics.rows,
    coverage: report.metrics.coverage,
    fieldAccuracy: report.metrics.fieldAccuracy,
    sourcePreservationRate: report.metrics.sourcePreservationRate,
    sourceAlignmentRate: report.metrics.sourceAlignmentRate,
    failures: report.details.filter(item => !item.covered || item.fieldMisses.length || !item.sourcePreserved || !item.sourceAligned).length,
}, null, 2));
