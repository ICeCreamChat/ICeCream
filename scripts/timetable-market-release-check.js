#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseTimetableRules } from '../gateway/services/timetable-rule-parser.js';
import {
    countExpectedFieldChecks,
    loadConstraintCorpus,
    MARKET_LANGUAGE_CATEGORIES,
    validateConstraintCorpus,
} from './lib/timetable-market-language-corpus.js';
import { AI_REQUIREMENT_PROMPT_VERSION } from '../gateway/services/timetable-ai-prompts.js';
import { timetableAiGoldenGateFailures } from './lib/timetable-ai-golden-runner.js';
import {
    createDefaultTimetableProject,
    normalizeTimetableProject,
    runTimetableScheduler,
} from '../gateway/services/timetable-scheduler.js';

function hasFlag(name) {
    return process.argv.includes(name);
}

function status(ok, label, detail = '') {
    return { status: ok ? 'pass' : 'manual_required', label, detail };
}

async function corpusCheck() {
    const corpus = await loadConstraintCorpus();
    const validation = validateConstraintCorpus(corpus.rows);
    const fieldChecks = countExpectedFieldChecks(corpus.rows);
    const categoryCounts = validation.metrics?.categoryCounts || {};
    const primaryCounts = validation.metrics?.primaryCounts || {};
    const passingCategories = MARKET_LANGUAGE_CATEGORIES.filter(category => (
        Number(categoryCounts[category] || 0) >= 15
        && Number(primaryCounts[category] || 0) >= 10
    )).length;
    const errors = [...(corpus.errors || []), ...(validation.errors || [])];
    const ok = errors.length === 0
        && validation.valid
        && fieldChecks > 0
        && passingCategories === MARKET_LANGUAGE_CATEGORIES.length;
    const metrics = validation.metrics || {};
    const detail = ok
        ? [
            `${metrics.rowCount || 0} rows`,
            `${metrics.uniqueIdCount || 0} unique ids`,
            `${passingCategories}/${MARKET_LANGUAGE_CATEGORIES.length} categories`,
            `${metrics.expectedClauseCount || 0} expected clauses`,
            `${fieldChecks} field checks`,
            `sha256 ${corpus.hash}`,
        ].join(', ')
        : errors.slice(0, 5).join('; ') || 'market-language corpus contract is incomplete';
    return status(ok, 'market-language golden corpus contract', detail);
}

async function aiGoldenReportCheck() {
    const reportPath = path.resolve(process.env.TIMETABLE_RULE_AI_GOLDEN_REPORT || '.tmp-timetable-ai-golden-latest.json');
    let report;
    try {
        report = JSON.parse(await readFile(reportPath, 'utf8'));
    } catch (error) {
        return status(false, 'full AI golden report', `report unavailable: ${error?.code || error?.message || error}`);
    }
    const corpus = await loadConstraintCorpus();
    const reasons = [];
    if (report.fullCorpus !== true) reasons.push('fullCorpus must be true');
    if (report.corpusRows !== corpus.rows.length) reasons.push(`corpusRows ${report.corpusRows} != ${corpus.rows.length}`);
    if (report.corpusTotalRows !== corpus.rows.length) reasons.push(`corpusTotalRows ${report.corpusTotalRows} != ${corpus.rows.length}`);
    if (report.corpusHash !== corpus.hash) reasons.push(`corpusHash ${report.corpusHash || '(missing)'} != ${corpus.hash}`);
    if (report.promptVersion !== AI_REQUIREMENT_PROMPT_VERSION) reasons.push(`promptVersion ${report.promptVersion || '(missing)'} != ${AI_REQUIREMENT_PROMPT_VERSION}`);
    if (!String(Array.isArray(report.model) ? report.model.join(',') : report.model || '').trim()) reasons.push('model is missing');
    if (!report.generatedAt) reasons.push('generatedAt is missing');
    if ((report.selectedIds || []).length) reasons.push('selectedIds must be empty for full corpus validation');
    const detailIds = (report.details || []).map(item => item?.id).filter(Boolean);
    if (detailIds.length !== corpus.rows.length || new Set(detailIds).size !== corpus.rows.length) {
        reasons.push(`details must contain ${corpus.rows.length} unique corpus ids`);
    }
    reasons.push(...timetableAiGoldenGateFailures(report));
    const ok = reasons.length === 0;
    const detail = ok
        ? `${report.model}, ${report.promptVersion}, ${report.corpusRows} rows, coverage ${report.coverage}, field ${report.fieldAccuracy}, source ${report.sourcePreservationRate}/${report.sourceAlignmentRate}, P95 ${report.p95Ms}ms, sha256 ${report.corpusHash}`
        : reasons.join('; ');
    return status(ok, 'full AI golden report', detail);
}

function demoProject(classCount = 3) {
    const classes = Array.from({ length: classCount }, (_, index) => ({ id: `c${index + 1}`, grade: 'G7', name: `${index + 1}` }));
    const teachers = Array.from({ length: classCount }, (_, index) => ({
        id: `t_math_${index + 1}`,
        name: `数学老师${index + 1}`,
        subjects: ['math'],
        unavailableSlots: [],
    }));
    return createDefaultTimetableProject({
        schoolName: `Release Check ${classCount}`,
        term: '2026',
        weekdays: 5,
        periodsPerDay: 8,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7, 8],
        teachers,
        classes,
        subjects: [{ id: 'math', name: '数学', priority: 90, color: '#2563eb' }],
        lessonPlans: classes.map(klass => ({
            id: `lp_${klass.id}_math`,
            classId: klass.id,
            subjectId: 'math',
            teacherId: `t_math_${Number.parseInt(klass.id.slice(1), 10) || 1}`,
            weeklyHours: 3,
        })),
        rules: { hardRules: {}, softRules: {} },
    });
}

async function offlineFallbackCheck() {
    const result = await parseTimetableRules({
        project: demoProject(1),
        text: '数学尽量上午',
        env: {
            TIMETABLE_RULE_AI_EXTRACT: '1',
            TIMETABLE_RULE_AI_REVIEW_DISABLED: '1',
        },
    });
    return status(result.parseSource === 'local_text', 'AI offline fallback', result.parseSource);
}

async function historicalRegressionCheck() {
    const files = [
        'test/fixtures/timetable-history-1.json',
        'test/fixtures/timetable-history-2.json',
        'test/fixtures/timetable-history-3.json',
    ];
    const projects = await Promise.all(files.map(async file => (
        normalizeTimetableProject(JSON.parse(await readFile(path.join(process.cwd(), file), 'utf8')))
    )));
    const solved = projects.map(project => runTimetableScheduler(project, { seed: 'release-check' }));
    const ok = solved.every(result => result.success && result.schedule?.score?.hardConflicts === 0);
    return status(ok, '3 historical data files + schedule regression', solved.map(result => `${result.schedule?.slots?.length || 0} slots`).join(', '));
}

async function stressCheck() {
    if (!hasFlag('--run-stress')) {
        return { status: 'manual_required', label: '100-class stress project', detail: 'run with --run-stress before release' };
    }
    const started = Date.now();
    const result = runTimetableScheduler(demoProject(100), { seed: 'release-check-100' });
    const durationMs = Date.now() - started;
    const ok = Boolean(result.success && result.schedule?.slots?.length);
    return status(ok, '100-class stress project', `${durationMs}ms, ${result.schedule?.slots?.length || 0} slots`);
}

async function chineseCopyCheck() {
    const files = [
        'public/js/tools/timetable/controller.js',
        'public/js/tools/timetable/controller-constraint-dialog.js',
        'public/js/tools/timetable/grid-interactions.js',
    ];
    const issues = [];
    for (const file of files) {
        const source = await readFile(path.join(process.cwd(), file), 'utf8');
        const matches = source.matchAll(/\b(alert|confirm)\(\s*(['"`])([^'"`]*?)\2/g);
        for (const match of matches) {
            if (match[3].includes('${')) continue;
            if (!/[\u4e00-\u9fa5]/.test(match[3])) issues.push(`${file}: ${match[1]}(${match[3]})`);
        }
    }
    return status(issues.length === 0, 'Chinese alert/confirm copy audit', issues.slice(0, 5).join('; ') || 'all checked');
}

async function main() {
    const checks = [
        await corpusCheck(),
        await aiGoldenReportCheck(),
        await historicalRegressionCheck(),
        await offlineFallbackCheck(),
        await stressCheck(),
        await chineseCopyCheck(),
    ];
    const payload = {
        generatedAt: new Date().toISOString(),
        checks,
        pass: checks.every(item => item.status === 'pass'),
    };
    if (hasFlag('--json')) {
        console.log(JSON.stringify(payload, null, 2));
    } else {
        console.log('# Timetable Market Release Check');
        checks.forEach(item => {
            console.log(`- [${item.status === 'pass' ? 'x' : ' '}] ${item.label}: ${item.detail}`);
        });
    }
    if (!payload.pass) process.exitCode = 1;
}

main().catch(error => {
    console.error('[timetable-market-release-check] failed:', error?.message || error);
    process.exitCode = 1;
});
