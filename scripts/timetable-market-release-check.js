#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseTimetableRules } from '../gateway/services/timetable-rule-parser.js';
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
    const corpusPath = path.join(process.cwd(), 'test/fixtures/constraint-corpus.jsonl');
    const baselinePath = path.join(process.cwd(), 'test/fixtures/corpus-baseline.md');
    const corpus = await readFile(corpusPath, 'utf8');
    const baseline = await readFile(baselinePath, 'utf8');
    const rows = corpus.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    return status(rows.length >= 100 && /字段准确率基线/.test(baseline), 'golden corpus baseline', `${rows.length} rows`);
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
