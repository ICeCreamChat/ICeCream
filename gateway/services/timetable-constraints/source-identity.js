import { createHash } from 'node:crypto';

export const SOURCE_SCHEMA_NAMESPACE = 'timetable-natural-language-source:v2';
export const SOURCE_SCHEMA_VERSION = 2;

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map(key => [key, canonicalize(value[key])])
        );
    }
    return value;
}
function stableStringify(value) {
    return JSON.stringify(canonicalize(value));
}

function sha256(value) {
    return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function slug(value = '', fallback = 'source') {
    const normalized = normalizeSourceText(value)
        .toLowerCase()
        .replace(/[\\/:*?"<>|\s]+/g, '-')
        .replace(/[^\p{Letter}\p{Number}._-]+/gu, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return (normalized || fallback).slice(0, 48);
}

export function normalizeSourceDisplayText(value = '') {
    return String(value ?? '')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .trim();
}

export function normalizeSourceText(value = '') {
    return normalizeSourceDisplayText(value)
        .normalize('NFKC')
        .replace(/[\t\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/ {2,}/g, ' ')
        .trim();
}

export function buildTextHash(rawText = '') {
    return sha256(`${SOURCE_SCHEMA_NAMESPACE}\ntext\n${normalizeSourceText(rawText)}`);
}

function sourceKind(source = {}, context = {}) {
    const explicit = normalizeSourceText(source.kind || context.kind || '').toLowerCase();
    if (explicit) return explicit;
    const inputType = normalizeSourceText(source.inputType || context.inputType || '').toLowerCase();
    if (inputType.startsWith('xlsx') || source.sourceSheet || source.sheetName) return 'xlsx';
    if (inputType === 'csv_text' || inputType === 'csv') return 'csv';
    if (inputType === 'txt') return 'txt';
    if (inputType === 'manual' || context.origin === 'manual') return 'manual';
    return 'text';
}

function sourcePosition(source = {}, context = {}) {
    const rowNumber = Number(source.rowNumber ?? source.sourceRow ?? context.rowNumber ?? context.sourceRow);
    if (Number.isInteger(rowNumber) && rowNumber > 0) return { kind: 'row', value: rowNumber };
    const lineNumber = Number(source.lineNumber ?? context.lineNumber);
    if (Number.isInteger(lineNumber) && lineNumber > 0) return { kind: 'line', value: lineNumber };
    const sourceIndex = Number(source.sourceIndex ?? source.index ?? context.sourceIndex ?? context.index);
    if (Number.isInteger(sourceIndex) && sourceIndex >= 0) return { kind: 'item', value: sourceIndex + 1 };
    return { kind: 'item', value: 1 };
}

export function buildSourceId(source = {}, context = {}) {
    const rawText = normalizeSourceText(
        source.rawText
        ?? source.constraintText
        ?? source.text
        ?? context.rawText
        ?? ''
    );
    const kind = sourceKind(source, context);
    const inputType = normalizeSourceText(source.inputType || context.inputType || kind).toLowerCase() || kind;
    const sheetName = normalizeSourceText(source.sheetName || source.sourceSheet || context.sheetName || context.sourceSheet || '');
    const position = sourcePosition(source, context);
    const payload = {
        namespace: SOURCE_SCHEMA_NAMESPACE,
        kind,
        inputType,
        sheetName,
        position,
        normalizedText: rawText,
    };
    const digest = sha256(stableStringify(payload)).slice(0, 20);
    const scope = kind === 'xlsx'
        ? `${slug(sheetName, 'sheet')}:r${position.value}`
        : `${position.kind[0]}${position.value}`;
    return `src:${SOURCE_SCHEMA_VERSION}:${slug(inputType, kind)}:${scope}:${digest}`;
}

export function buildClauseId(sourceId, clause = {}, index = 0) {
    const explicit = normalizeSourceText(clause.clauseId || '');
    if (explicit && explicit.startsWith(`${sourceId}:clause:`)) return explicit;
    const digest = sha256(stableStringify({
        namespace: SOURCE_SCHEMA_NAMESPACE,
        sourceId,
        intent: clause.intent || clause.capability || clause.type || '',
        target: clause.target || clause.object || clause.scope || null,
        condition: clause.condition || clause.time || null,
        relation: clause.relation || null,
        parameters: clause.parameters || clause.params || null,
        strength: clause.strength || '',
        applyTo: clause.applyTo || '',
    })).slice(0, 20);
    void index;
    return `${sourceId}:clause:${digest}`;
}

const MACHINE_RULE_ID_METADATA_FIELDS = new Set([
    'id',
    'machineRuleId',
    'stableKey',
    'rowId',
    'requirementId',
    'clauseId',
    'sourceId',
    'textHash',
    'origin',
    'parsedBy',
    'source',
    'sourceSheet',
    'sourceRow',
    'lineNumber',
    'rawText',
    'constraintText',
    'parseSource',
    'status',
    'sourceStatus',
    'confidence',
    'warnings',
    'aiReviewStatus',
    'aiReviewWarnings',
    'reviewEvidence',
    'reviewedParseSource',
    'ambiguity',
    'ambiguities',
    'description',
    'reason',
    'note',
    'sourceOrder',
    'generatedBy',
    'compilerVersion',
    'enabled',
    'modelSupport',
    'clarification',
    'createdAt',
    'updatedAt',
]);

function machineRuleIdentityPayload(rule = {}) {
    return Object.fromEntries(
        Object.entries(rule)
            .filter(([key, value]) => !MACHINE_RULE_ID_METADATA_FIELDS.has(key)
                && value !== undefined
                && typeof value !== 'function')
    );
}

export function buildMachineRuleId(sourceId, clauseId, rule = {}, index = 0) {
    const explicit = normalizeSourceText(rule.machineRuleId || '');
    if (explicit && explicit.startsWith(`${sourceId}:rule:`)) return explicit;
    const digest = sha256(stableStringify({
        namespace: SOURCE_SCHEMA_NAMESPACE,
        sourceId,
        clauseId,
        rule: machineRuleIdentityPayload(rule),
    })).slice(0, 20);
    void index;
    return `${sourceId}:rule:${digest}`;
}

export function sameSourceTextHash(left = '', right = '') {
    return Boolean(left && right && String(left) === String(right));
}

export function validateUniqueSourceIds(items = []) {
    const seen = new Set();
    const duplicates = [];
    const sources = Array.isArray(items)
        ? items
        : (items === null || items === undefined || items === '' ? [] : [items]);
    for (const item of sources) {
        const sourceId = normalizeSourceText(item?.sourceId || '');
        if (!sourceId || seen.has(sourceId)) duplicates.push(sourceId || '(missing)');
        if (sourceId) seen.add(sourceId);
    }
    return {
        valid: duplicates.length === 0,
        duplicates: [...new Set(duplicates)],
        uniqueCount: seen.size,
    };
}
