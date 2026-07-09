import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { gatewayPaths } from '../config/paths.js';

const METRICS_FILE = 'constraint-metrics.jsonl';
const MISS_FILE = 'constraint-miss.jsonl';

function nowIso() {
    return new Date().toISOString();
}

function text(value = '', max = 1000) {
    return String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function hashText(value = '') {
    return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function firstDefined(...values) {
    return values.find(value => value !== undefined && value !== null);
}

function numericValue(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function logsDir(env = process.env) {
    return env.TIMETABLE_CONSTRAINT_LOG_DIR
        || path.join(gatewayPaths.projectRoot, 'logs');
}

function metricPath(env = process.env) {
    return path.join(logsDir(env), METRICS_FILE);
}

function missPath(env = process.env) {
    return path.join(logsDir(env), MISS_FILE);
}

async function appendJsonLine(filePath = '', record = {}) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

export function redactConstraintText(value = '') {
    return text(value, 1000)
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
        .replace(/1[3-9]\d{9}/g, '[phone]')
        .replace(/\b\d{6,}\b/g, '[number]')
        .replace(/[\u4e00-\u9fa5]{1,4}(老师|教师)/g, '某老师')
        .replace(/[\u4e00-\u9fa5]{1,4}(同学|学生)/g, '某学生');
}

export async function recordConstraintMetric(event = {}, { env = process.env } = {}) {
    const phase = text(event.phase || event.type || 'unknown', 80);
    const durationMs = Number.isFinite(Number(event.durationMs)) ? Number(event.durationMs) : null;
    const requirementCount = numericValue(firstDefined(event.requirementCount, event.extracted_count, event.extractedCount), 0);
    const clarificationCount = numericValue(firstDefined(event.clarificationCount, event.clarify_count, event.clarifyCount), 0);
    const appliedRuleCount = numericValue(event.appliedRuleCount, 0);
    const appliedSemanticActionCount = numericValue(event.appliedSemanticActionCount, 0);
    const applyCount = numericValue(
        firstDefined(event.apply_count, event.applyCount),
        appliedRuleCount + appliedSemanticActionCount,
    );
    const hardViolationCount = numericValue(firstDefined(event.hardViolationCount, event.hard_violations), 0);
    const softViolationCount = numericValue(firstDefined(event.softViolationCount, event.soft_violations), 0);
    const ai = event.ai && typeof event.ai === 'object' ? event.ai : null;
    const parseId = text(firstDefined(event.parse_id, event.parseId), 120)
        || hashText(`${phase}:${nowIso()}:${event.parseSource || ''}:${requirementCount}`).slice(0, 20);
    const inputType = text(firstDefined(event.input_type, event.inputType), 80);
    const sentenceCount = numericValue(firstDefined(
        event.sentence_count,
        event.sentenceCount,
        ai?.batchSentenceCount,
    ), 0);
    const aiUsed = firstDefined(event.ai_used, event.aiUsed) === undefined
        ? Boolean(ai || /ai/i.test(String(event.parseSource || '')) || phase === 'ai')
        : Boolean(firstDefined(event.ai_used, event.aiUsed));
    const aiMs = numericValue(firstDefined(
        event.ai_ms,
        event.aiMs,
        phase === 'ai' ? durationMs : undefined,
    ), 0);
    const solveMs = numericValue(firstDefined(
        event.solve_ms,
        event.solveMs,
        phase === 'solve' ? durationMs : undefined,
    ), 0);
    const record = {
        ts: nowIso(),
        phase,
        success: event.success === undefined ? null : Boolean(event.success),
        durationMs,
        parseSource: text(event.parseSource || '', 80),
        parseId,
        inputType,
        sentenceCount,
        aiUsed,
        aiMs,
        extractedCount: requirementCount,
        clarifyCount: clarificationCount,
        applyCount,
        solveMs,
        ai,
        clarificationCount,
        requirementCount,
        appliedRuleCount,
        appliedSemanticActionCount,
        solveSuccess: event.solveSuccess === undefined ? null : Boolean(event.solveSuccess),
        hardViolationCount,
        softViolationCount,
        parse_id: parseId,
        input_type: inputType,
        sentence_count: sentenceCount,
        ai_used: aiUsed,
        ai_ms: aiMs,
        extracted_count: requirementCount,
        clarify_count: clarificationCount,
        apply_count: applyCount,
        solve_ms: solveMs,
        hard_violations: hardViolationCount,
        soft_violations: softViolationCount,
        reason: text(event.reason || '', 120),
        project: event.project && typeof event.project === 'object' ? {
            classCount: Number(event.project.classCount || 0),
            teacherCount: Number(event.project.teacherCount || 0),
            subjectCount: Number(event.project.subjectCount || 0),
            lessonPlanCount: Number(event.project.lessonPlanCount || 0),
        } : null,
    };
    try {
        await appendJsonLine(metricPath(env), record);
        return record;
    } catch (error) {
        return {
            ...record,
            writeFailed: true,
            writeError: text(error?.message || error, 240),
        };
    }
}

export async function recordConstraintMissSample(sample = {}, { env = process.env } = {}) {
    const input = text(sample.input || sample.text || '', 4000);
    const record = {
        ts: nowIso(),
        phase: text(sample.phase || 'parse', 80),
        reason: text(sample.reason || 'unknown', 120),
        inputHash: input ? hashText(input) : '',
        inputPreview: redactConstraintText(input).slice(0, 240),
        parseSource: text(sample.parseSource || '', 80),
        model: text(sample.model || '', 120),
        warnings: Array.isArray(sample.warnings) ? sample.warnings.map(item => text(item, 180)).slice(0, 10) : [],
    };
    try {
        await appendJsonLine(missPath(env), record);
        return record;
    } catch (error) {
        return {
            ...record,
            writeFailed: true,
            writeError: text(error?.message || error, 240),
        };
    }
}

async function readJsonl(filePath = '') {
    try {
        const raw = await readFile(filePath, 'utf8');
        return raw
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => JSON.parse(line));
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

function rate(numerator = 0, denominator = 0) {
    return denominator ? Number((numerator / denominator).toFixed(4)) : 0;
}

export async function summarizeConstraintMetrics({ env = process.env, since = null } = {}) {
    const sinceTime = since ? new Date(since).getTime() : 0;
    const rows = (await readJsonl(metricPath(env))).filter(row => {
        if (!sinceTime) return true;
        return new Date(row.ts).getTime() >= sinceTime;
    });
    const parseRows = rows.filter(row => row.phase === 'parse');
    const clarifyRows = rows.filter(row => row.phase === 'clarify');
    const applyRows = rows.filter(row => row.phase === 'apply');
    const solveRows = rows.filter(row => row.phase === 'solve');
    const aiRows = rows.filter(row => row.phase === 'ai');
    const missRows = await readJsonl(missPath(env));

    return {
        generatedAt: nowIso(),
        logDir: logsDir(env),
        totalEvents: rows.length,
        parse: {
            attempts: parseRows.length,
            success: parseRows.filter(row => row.success).length,
            successRate: rate(parseRows.filter(row => row.success).length, parseRows.length),
            clarificationRate: rate(parseRows.filter(row => Number(row.clarificationCount || 0) > 0).length, parseRows.length),
        },
        ai: {
            attempts: aiRows.length,
            success: aiRows.filter(row => row.success).length,
            cacheHits: aiRows.filter(row => row.ai?.cacheHit).length,
            batchCalls: aiRows.filter(row => Number(row.ai?.batchChunkCount || 0) > 1).length,
        },
        clarify: {
            turns: clarifyRows.length,
        },
        apply: {
            attempts: applyRows.length,
            success: applyRows.filter(row => row.success).length,
            successRate: rate(applyRows.filter(row => row.success).length, applyRows.length),
            appliedRules: applyRows.reduce((sum, row) => sum + Number(row.appliedRuleCount || 0), 0),
            appliedActions: applyRows.reduce((sum, row) => sum + Number(row.appliedSemanticActionCount || 0), 0),
        },
        solve: {
            attempts: solveRows.length,
            success: solveRows.filter(row => row.solveSuccess || row.success).length,
            successRate: rate(solveRows.filter(row => row.solveSuccess || row.success).length, solveRows.length),
            hardViolations: solveRows.reduce((sum, row) => sum + Number(row.hardViolationCount || 0), 0),
            softViolations: solveRows.reduce((sum, row) => sum + Number(row.softViolationCount || 0), 0),
        },
        missSamples: missRows.length,
    };
}
