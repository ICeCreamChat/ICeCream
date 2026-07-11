import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CORPUS_PATH = 'test/fixtures/constraint-corpus.jsonl';
export const MARKET_LANGUAGE_CATEGORIES = Object.freeze([
    'colloquial',
    'noisy_text',
    'ellipsis',
    'cross_sentence_reference',
    'complex_negation',
    'school_terminology',
]);

function asList(value) {
    if (Array.isArray(value)) return value.filter(item => item !== undefined && item !== null);
    return value === undefined || value === null || value === '' ? [] : [value];
}

function uniqueStrings(values = []) {
    return [...new Set(asList(values).map(value => String(value || '').trim()).filter(Boolean))];
}

export function corpusSha256(content = '') {
    return createHash('sha256').update(content).digest('hex');
}

export function normalizeCorpusRow(row = {}, { lineNumber = null } = {}) {
    const expectedClauses = asList(row.expectedClauses ?? row.expectedFields)
        .filter(item => item && typeof item === 'object' && !Array.isArray(item))
        .map(item => ({ ...item }));
    const expectedIntents = uniqueStrings([
        ...asList(row.expectedIntents),
        ...expectedClauses.map(item => item.intent),
    ]);
    const categories = uniqueStrings(row.categories);
    const primaryCategory = String(row.primaryCategory || '').trim() || null;
    const needsClarification = Boolean(
        row.needsClarification
        || expectedClauses.some(item => item.needsClarification === true)
        || row.understandingStatus === 'needs_clarification'
    );
    const unrecognized = Boolean(row.unrecognized || row.understandingStatus === 'unrecognized');
    return {
        ...row,
        id: String(row.id || '').trim(),
        text: String(row.text || ''),
        categories,
        primaryCategory,
        expectedIntents,
        expectedClauses,
        needsClarification,
        unrecognized,
        understandingStatus: String(row.understandingStatus || '').trim()
            || (unrecognized ? 'unrecognized' : needsClarification ? 'needs_clarification' : 'understood'),
        executionStatus: String(row.executionStatus || '').trim()
            || (unrecognized ? 'unsupported' : needsClarification ? 'review' : 'ready'),
        notes: String(row.notes || '').trim(),
        ...(lineNumber ? { lineNumber } : {}),
    };
}

export function parseCorpusJsonl(content = '', { filePath = DEFAULT_CORPUS_PATH } = {}) {
    const rows = [];
    const errors = [];
    String(content).split(/\r?\n/).forEach((line, index) => {
        if (!line.trim()) return;
        try {
            rows.push(normalizeCorpusRow(JSON.parse(line), { lineNumber: index + 1 }));
        } catch (error) {
            errors.push(`${filePath}:${index + 1}: invalid JSON: ${error.message}`);
        }
    });
    return { rows, errors, hash: corpusSha256(content), filePath };
}

export async function loadConstraintCorpus(filePath = DEFAULT_CORPUS_PATH) {
    const absolutePath = path.resolve(process.cwd(), filePath);
    const content = await readFile(absolutePath, 'utf8');
    return { ...parseCorpusJsonl(content, { filePath }), absolutePath, content };
}

function validateExpectedClause(row, clause, clauseIndex, errors) {
    const prefix = `${row.id || `line ${row.lineNumber || '?'}`} expectedClauses[${clauseIndex}]`;
    if (!clause || typeof clause !== 'object' || Array.isArray(clause)) {
        errors.push(`${prefix}: must be an object`);
        return;
    }
    if (!String(clause.intent || '').trim()) errors.push(`${prefix}: intent is required`);
    for (const key of ['targetNames', 'exceptions']) {
        if (clause[key] !== undefined && !Array.isArray(clause[key])) errors.push(`${prefix}: ${key} must be an array`);
    }
    for (const key of ['time', 'params', 'negation']) {
        if (clause[key] !== undefined && (!clause[key] || typeof clause[key] !== 'object' || Array.isArray(clause[key]))) {
            errors.push(`${prefix}: ${key} must be an object`);
        }
    }
}

export function validateConstraintCorpus(rows = [], {
    minimumRows = 200,
    minimumCategoryRows = 15,
    minimumPrimaryRows = 10,
    categories = MARKET_LANGUAGE_CATEGORIES,
} = {}) {
    const errors = [];
    const warnings = [];
    const ids = new Map();
    const allowedCategories = new Set(categories);
    const categoryCounts = Object.fromEntries(categories.map(category => [category, 0]));
    const primaryCounts = Object.fromEntries(categories.map(category => [category, 0]));

    if (!Array.isArray(rows)) return { valid: false, errors: ['corpus must be an array'], warnings, metrics: {} };
    if (rows.length < minimumRows) errors.push(`corpus row count ${rows.length} is below minimum ${minimumRows}`);

    for (const rawRow of rows) {
        const row = normalizeCorpusRow(rawRow, { lineNumber: rawRow?.lineNumber });
        const label = row.id || `line ${row.lineNumber || '?'}`;
        if (!row.id) errors.push(`${label}: id is required`);
        else if (ids.has(row.id)) errors.push(`${label}: duplicate id (first seen at line ${ids.get(row.id)})`);
        else ids.set(row.id, row.lineNumber || '?');
        if (!row.text.trim()) errors.push(`${label}: text is required`);

        for (const category of row.categories) {
            if (!allowedCategories.has(category)) errors.push(`${label}: unknown category ${category}`);
            else categoryCounts[category] += 1;
        }
        if (row.primaryCategory) {
            if (!allowedCategories.has(row.primaryCategory)) errors.push(`${label}: unknown primaryCategory ${row.primaryCategory}`);
            else {
                primaryCounts[row.primaryCategory] += 1;
                if (!row.categories.includes(row.primaryCategory)) errors.push(`${label}: primaryCategory must also appear in categories`);
            }
        } else if (row.categories.length) {
            errors.push(`${label}: categorized row must define primaryCategory`);
        }

        if (!row.unrecognized && row.expectedIntents.length === 0 && row.expectedClauses.length === 0) {
            errors.push(`${label}: expected truth is required`);
        }
        row.expectedClauses.forEach((clause, index) => validateExpectedClause(row, clause, index, errors));
    }

    for (const category of categories) {
        if (categoryCounts[category] < minimumCategoryRows) errors.push(`${category}: category rows ${categoryCounts[category]} below minimum ${minimumCategoryRows}`);
        if (primaryCounts[category] < minimumPrimaryRows) errors.push(`${category}: primary rows ${primaryCounts[category]} below minimum ${minimumPrimaryRows}`);
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        metrics: {
            rowCount: rows.length,
            uniqueIdCount: ids.size,
            categoryCounts,
            primaryCounts,
            expectedClauseCount: rows.reduce((total, row) => total + normalizeCorpusRow(row).expectedClauses.length, 0),
        },
    };
}

export function comparableName(value = '') {
    return String(value ?? '')
        .replace(/老师|教师|课程|科目|学科|教研组|备课组|小组|组|班级|班/g, '')
        .replace(/[\s()（）\-_.]/g, '')
        .toLowerCase();
}

export function collectCandidateValues(items = [], pathParts = []) {
    const values = [];
    for (const item of asList(items)) {
        let current = item;
        for (const part of pathParts) current = current?.[part];
        values.push(...asList(current));
    }
    return values;
}

function arrayIncludesAll(actual = [], expected = [], { names = false } = {}) {
    const normalize = names ? comparableName : value => String(value);
    const actualValues = actual.map(normalize).filter(Boolean);
    return asList(expected).map(normalize).filter(Boolean).every(expectedValue => actualValues.some(actualValue => (
        actualValue === expectedValue || (names && (actualValue.includes(expectedValue) || expectedValue.includes(actualValue)))
    )));
}

export function equivalentIntentsFor(item = {}) {
    const intents = new Set([item.intent, item.type].filter(Boolean));
    const capabilityId = String(item.capabilityId || '');
    if (capabilityId === 'teacher.unavailable') intents.add('teacher_unavailable');
    if (capabilityId === 'class.unavailable'
        || capabilityId === 'class.fixed_activity'
        || (item.intent === 'unavailable_periods' && (item.targetKind === 'class' || item.targetType === 'class' || item.object?.kind === 'class')))
        intents.add('class_unavailable');
    if (capabilityId === 'subject.avoid_periods') intents.add('subject_avoid_periods');
    if (capabilityId === 'subject.preferred_periods') intents.add('subject_preferred_periods');
    const evidence = String(item.evidence || item.rawText || '').replace(/\s+/g, '');
    const periods = new Set([
        ...collectCandidateValues([item], ['time', 'periods']).map(Number),
        ...collectCandidateValues([item], ['time', 'slots']).map(slot => Number(String(slot).split('-')[1])).filter(Boolean),
    ]);
    if (intents.has('subject_avoid_periods') || intents.has('teacher_avoid_periods')) {
        if (periods.has(1) || /(第一节|首节|第1节|上午第一节)/.test(evidence)) intents.add('avoid_first_period');
        if (/(最后一节|放学前|末节)/.test(evidence)) intents.add('avoid_last_period');
    }
    if (intents.has('locked_slot') && /(早读|首节)/.test(evidence)) intents.add('first_period_assign');
    if (/(固定|主持).*(班会|课)|班会.*固定/.test(evidence)) intents.add('locked_slot');
    if ((intents.has('subject_morning') || intents.has('subject_preferred_periods')) && /(黄金|前四节|主科|数理化)/.test(evidence)) intents.add('golden_hour_preference');
    if (intents.has('golden_hour_preference')) intents.add('subject_morning');
    if (intents.has('global_unavailable') && /^(全部|所有|全体|每位|每个|各位).*(教师|老师)/.test(evidence)) intents.add('teacher_unavailable');
    if (intents.has('global_unavailable') && /(午休|中午最后一节|下午第一节)/.test(evidence)) intents.add('lunch_protection');
    if (/全校.*(社团|升旗|大扫除|活动|教研)|不排主课/.test(evidence)) intents.add('global_unavailable');
    if (intents.has('teaching_group_meeting')) intents.add('teacher_unavailable');
    if (/隔天排|至少隔|间隔/.test(evidence)) intents.add('course_interval');
    return intents;
}

function requirementMatchesIntent(item = {}, expectedIntent = '') {
    return equivalentIntentsFor(item).has(expectedIntent);
}

function valueMatchesAny(candidates = [], pathParts = [], expected) {
    const values = collectCandidateValues(candidates, pathParts);
    return Array.isArray(expected) ? arrayIncludesAll(values, expected) : values.some(value => String(value) === String(expected));
}

function timeValueMatches(candidates = [], field = '', expected = []) {
    const values = collectCandidateValues(candidates, ['time', field]);
    if (field === 'days' || field === 'periods') {
        for (const slot of collectCandidateValues(candidates, ['time', 'slots'])) {
            const [day, period] = String(slot).split('-').map(Number);
            if (field === 'days' && Number.isInteger(day)) values.push(day);
            if (field === 'periods' && Number.isInteger(period)) values.push(period);
        }
    }
    return Array.isArray(expected) ? arrayIncludesAll(values, expected) : values.some(value => String(value) === String(expected));
}

function paramValueMatches(candidates = [], key = '', expected) {
    const aliases = {
        minGapDays: ['minGapDays', 'intervalDays', 'gapDays', 'days'],
        roomName: ['roomName', 'roomNames', 'rooms'],
        limit: ['limit', 'max', 'maxPerDay', 'maxConsecutive', 'maxDays'],
        blockSize: ['blockSize', 'consecutivePeriods', 'length'],
    };
    const values = (aliases[key] || [key]).flatMap(alias => collectCandidateValues(candidates, ['params', alias]));
    return Array.isArray(expected) ? arrayIncludesAll(values, expected) : values.some(value => String(value) === String(expected));
}

export function scoreFieldExpectations(expectedFields = [], actualRequirements = []) {
    const misses = [];
    let hits = 0;
    let total = 0;
    for (const expected of asList(expectedFields)) {
        const candidates = asList(actualRequirements).filter(item => requirementMatchesIntent(item, expected.intent));
        const check = (field, matched) => {
            total += 1;
            if (matched) hits += 1;
            else misses.push({ intent: expected.intent, field, expected });
        };
        if (expected.targetKind) check('targetKind', candidates.some(item => item.targetKind === expected.targetKind));
        if (expected.targetNames) check('targetNames', arrayIncludesAll(collectCandidateValues(candidates, ['targetNames']), expected.targetNames, { names: true }));
        if (expected.strength) check('strength', candidates.some(item => item.strength === expected.strength));
        if (Object.prototype.hasOwnProperty.call(expected, 'needsClarification')) check('needsClarification', candidates.some(item => Boolean(item.needsClarification) === expected.needsClarification));
        if (expected.time?.days) check('time.days', timeValueMatches(candidates, 'days', expected.time.days));
        if (expected.time?.periods) check('time.periods', timeValueMatches(candidates, 'periods', expected.time.periods));
        if (expected.time?.dayPart) check('time.dayPart', valueMatchesAny(candidates, ['time', 'dayPart'], expected.time.dayPart));
        for (const [key, value] of Object.entries(expected.params || {})) check(`params.${key}`, paramValueMatches(candidates, key, value));
        for (const [key, value] of Object.entries(expected.negation || {})) check(`negation.${key}`, valueMatchesAny(candidates, ['negation', key], value));
        if (expected.exceptions) check('exceptions', arrayIncludesAll(collectCandidateValues(candidates, ['exceptions']), expected.exceptions, { names: true }));
        if (expected.activity) check('activity', valueMatchesAny(candidates, ['activity'], expected.activity));
    }
    return { hits, total, misses };
}

export function countExpectedFieldChecks(rows = []) {
    return asList(rows).flatMap(row => normalizeCorpusRow(row).expectedClauses).reduce((total, expected) => total
        + (expected.targetKind ? 1 : 0)
        + (expected.targetNames ? 1 : 0)
        + (expected.strength ? 1 : 0)
        + (Object.prototype.hasOwnProperty.call(expected, 'needsClarification') ? 1 : 0)
        + (expected.time?.days ? 1 : 0)
        + (expected.time?.periods ? 1 : 0)
        + (expected.time?.dayPart ? 1 : 0)
        + Object.keys(expected.params || {}).length
        + Object.keys(expected.negation || {}).length
        + (expected.exceptions ? 1 : 0)
        + (expected.activity ? 1 : 0), 0);
}

export function localParseResultToRequirements(result = {}, { morningEndPeriod = 4 } = {}) {
    const draftRows = asList(result.draftRows);
    const semanticRows = [
        ...asList(result.requirementItems),
        ...asList(result.sourceRequirements).flatMap(source => asList(source?.clauses)),
    ];
    const clarificationRows = semanticRows.filter(row => row
        && (row.needsClarification
            || row.status === 'needs_review'
            || row.reviewStatus === 'needs_review'
            || row.reviewStatus === 'needs_clarification'
            || row.executionStatus === 'needs_clarification'
            || row.understandingStatus === 'needs_clarification'
            || row.clarification
            || asList(row.clarifications).length > 0));
    const candidates = draftRows.length ? [...draftRows, ...clarificationRows] : semanticRows;
    const rows = candidates.filter((row, index) => {
        const identity = row?.clauseId || row?.requirementId || row?.rowId || row?.id;
        if (!identity) return true;
        return candidates.findIndex(candidate => (candidate?.clauseId || candidate?.requirementId || candidate?.rowId || candidate?.id) === identity) === index;
    });
    return rows.map(row => {
        const slots = uniqueStrings([
            ...asList(row.slots),
            ...asList(row.parameters?.slots),
            ...asList(row.condition?.slots),
        ]);
        const slotDays = slots.map(slot => Number(String(slot).split('-')[0])).filter(Number.isInteger);
        const slotPeriods = slots.map(slot => Number(String(slot).split('-')[1])).filter(Number.isInteger);
        const days = [...new Set([
            ...asList(row.days), ...asList(row.time?.days), ...asList(row.parameters?.days), ...asList(row.condition?.days), ...slotDays,
        ].map(Number).filter(Number.isInteger))];
        const periods = [...new Set([
            ...asList(row.periods), ...asList(row.time?.periods), ...asList(row.parameters?.periods), ...asList(row.condition?.periods), ...slotPeriods,
        ].map(Number).filter(Number.isInteger))];
        const targetNames = uniqueStrings([
            ...asList(row.targetNames), row.targetName,
            ...asList(row.teacherNames), row.teacherName,
            ...asList(row.subjectNames), row.subjectName,
            ...asList(row.classNames), row.className,
            ...asList(row.gradeNames), row.object?.name, row.target,
            ...asList(row.roomNames), row.roomName,
            ...asList(row.parameters?.roomNames), row.parameters?.roomName,
            ...asList(row.parameters?.roomRequirement?.roomNames), row.parameters?.roomRequirement?.roomName,
        ]);
        const dayPart = row.time?.dayPart
            || (periods.length && periods.every(period => period <= morningEndPeriod) ? 'morning'
                : periods.length && periods.every(period => period > morningEndPeriod) ? 'afternoon' : undefined);
        const intent = row.intent || row.type || row.capabilityId || 'unknown';
        const rawTargetKind = row.targetKind || row.targetType || row.object?.kind || '';
        const targetKind = rawTargetKind === 'derived_group' ? 'derived_group'
            : ['teacher_gap_preference', 'teacher_load_balance', 'class_daily_balance', 'lunch_protection'].includes(intent) ? 'global'
                : intent.startsWith('teacher_') ? 'teacher'
                : intent.startsWith('subject_') || ['avoid_first_period', 'avoid_last_period', 'golden_hour_preference', 'course_interval', 'block_preference', 'week_pattern', 'first_period_assign'].includes(intent) ? 'subject'
                    : intent.startsWith('class_') ? (rawTargetKind === 'grade' ? 'grade' : 'class')
                        : rawTargetKind;
        return {
            ...row,
            intent,
            capabilityId: row.capabilityId || row.constraintIR?.capabilityId || '',
            targetKind,
            targetNames,
            time: {
                ...(row.time || {}),
                ...(days.length ? { days } : {}),
                ...(periods.length ? { periods } : {}),
                ...(slots.length ? { slots } : {}),
                ...(dayPart ? { dayPart } : {}),
            },
            params: {
                ...(row.params || {}),
                ...(row.parameters || {}),
                ...(row.limit !== undefined ? { limit: row.limit } : {}),
                ...(row.maxPerDay !== undefined ? { limit: row.maxPerDay } : {}),
                ...(row.maxConsecutive !== undefined ? { limit: row.maxConsecutive } : {}),
                ...(row.minGapDays !== undefined ? { minGapDays: row.minGapDays } : {}),
                ...(row.roomName ? { roomName: row.roomName } : {}),
            },
            strength: row.strength || row.priority || '',
            needsClarification: Boolean(
                row.needsClarification
                || row.status === 'needs_review'
                || row.reviewStatus === 'needs_review'
                || row.executionStatus === 'needs_clarification'
                || row.reviewStatus === 'needs_clarification'
                || row.understandingStatus === 'needs_clarification'
                || asList(row.clarifications).length > 0
            ),
            evidence: row.evidence || row.rawText || row.description || '',
        };
    });
}

export function scoreCorpusRow(rowInput = {}, actualRequirements = [], { semanticRequirements = [], sourceRequirements = null } = {}) {
    const row = normalizeCorpusRow(rowInput);
    const actualIntents = new Set(asList(actualRequirements).flatMap(item => [...equivalentIntentsFor(item)]));
    const intentMisses = row.expectedIntents.filter(intent => !actualIntents.has(intent));
    const fields = scoreFieldExpectations(row.expectedClauses, actualRequirements);
    const clarificationOk = !row.needsClarification
        || asList(actualRequirements).some(item => item.needsClarification)
        || asList(semanticRequirements).some(item => item.status === 'needs_review'
            || item.reviewStatus === 'needs_clarification'
            || item.executionStatus === 'needs_clarification'
            || item.clarification
            || asList(item.clarifications).length > 0);
    const unrecognizedOk = !row.unrecognized
        || actualIntents.size === 0
        || actualIntents.has('unknown')
        || actualIntents.has('unrecognized');
    let sourcePreserved = null;
    let sourceAligned = null;
    if (Array.isArray(sourceRequirements)) {
        sourcePreserved = sourceRequirements.length === 1
            && sourceRequirements[0]?.rawText === row.text
            && Boolean(sourceRequirements[0]?.sourceId)
            && Boolean(sourceRequirements[0]?.textHash);
        const sourceId = sourceRequirements[0]?.sourceId;
        const textHash = sourceRequirements[0]?.textHash || sourceRequirements[0]?.source?.textHash;
        const artifacts = [...asList(actualRequirements), ...asList(semanticRequirements)];
        sourceAligned = Boolean(sourceId) && Boolean(textHash) && artifacts.every(item => {
            const artifactSourceId = item?.sourceId || item?.source?.sourceId;
            const artifactTextHash = item?.textHash || item?.source?.textHash;
            return artifactSourceId === sourceId && artifactTextHash === textHash;
        });
    }
    return {
        row,
        covered: unrecognizedOk && intentMisses.length === 0 && clarificationOk,
        intentMisses,
        actualIntents: [...actualIntents],
        fields,
        clarificationOk,
        unrecognizedOk,
        sourcePreserved,
        sourceAligned,
    };
}

export function aggregateCorpusScores(scores = []) {
    const categoryMetrics = Object.fromEntries(MARKET_LANGUAGE_CATEGORIES.map(category => [category, {
        rows: 0, covered: 0, fieldHits: 0, fieldTotal: 0, sourcePreserved: 0, sourceAligned: 0, sourceChecked: 0, clarificationSafe: 0, clarificationRows: 0, failures: [],
    }]));
    let covered = 0;
    let fieldHits = 0;
    let fieldTotal = 0;
    let sourcePreserved = 0;
    let sourceAligned = 0;
    let sourceChecked = 0;
    for (const score of scores) {
        if (score.covered) covered += 1;
        fieldHits += score.fields.hits;
        fieldTotal += score.fields.total;
        if (score.sourcePreserved !== null) {
            sourceChecked += 1;
            if (score.sourcePreserved) sourcePreserved += 1;
            if (score.sourceAligned) sourceAligned += 1;
        }
        for (const category of score.row.categories) {
            const metric = categoryMetrics[category];
            if (!metric) continue;
            metric.rows += 1;
            if (score.covered) metric.covered += 1;
            metric.fieldHits += score.fields.hits;
            metric.fieldTotal += score.fields.total;
            if (score.sourcePreserved !== null) {
                metric.sourceChecked += 1;
                if (score.sourcePreserved) metric.sourcePreserved += 1;
                if (score.sourceAligned) metric.sourceAligned += 1;
            }
            if (score.row.needsClarification) {
                metric.clarificationRows += 1;
                if (score.clarificationOk) metric.clarificationSafe += 1;
            }
            if (!score.covered || score.fields.misses.length || score.sourcePreserved === false || score.sourceAligned === false) {
                metric.failures.push({ id: score.row.id, intentMisses: score.intentMisses, fieldMisses: score.fields.misses });
            }
        }
    }
    return {
        rows: scores.length,
        covered,
        coverage: covered / Math.max(1, scores.length),
        fieldHits,
        fieldTotal,
        fieldAccuracy: fieldHits / Math.max(1, fieldTotal),
        sourcePreservationRate: sourcePreserved / Math.max(1, sourceChecked),
        sourceAlignmentRate: sourceAligned / Math.max(1, sourceChecked),
        categoryMetrics,
    };
}
