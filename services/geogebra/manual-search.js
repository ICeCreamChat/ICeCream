import { readFileSync } from 'node:fs';

const MANUAL_INDEX_URL = new URL('./manual-index.json', import.meta.url);
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

const manualEntries = loadManualEntries();
const searchableEntries = manualEntries.map(entry => ({
    ...entry,
    searchText: [
        entry.id,
        entry.type,
        entry.title,
        entry.summary,
        entry.source,
        ...(entry.keywords || []),
        ...(entry.syntax || []),
        ...(entry.examples || []),
    ].join(' ').toLowerCase(),
}));

function loadManualEntries() {
    const rawText = readFileSync(MANUAL_INDEX_URL, 'utf8');
    const parsed = JSON.parse(rawText);
    return Array.isArray(parsed) ? parsed : [];
}

export function normalizeManualSearchLimit(limitValue) {
    const parsedLimit = Number.parseInt(limitValue, 10);
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
        return DEFAULT_LIMIT;
    }
    return Math.min(parsedLimit, MAX_LIMIT);
}

function normalizeQuery(query) {
    return String(query || '')
        .toLowerCase()
        .split(/\s+/)
        .map(token => token.trim())
        .filter(Boolean);
}

function scoreEntry(entry, tokens) {
    return tokens.reduce((score, token) => {
        const title = entry.title.toLowerCase();
        const keywords = (entry.keywords || []).map(String).join(' ').toLowerCase();
        if (title === token) return score + 1000;
        if (title.startsWith(token)) return score + 700;
        if (keywords.includes(token)) return score + 520;
        if (entry.searchText.includes(token)) return score + 260;
        return score;
    }, 0);
}

function compactEntry(entry) {
    return {
        id: entry.id,
        type: entry.type,
        title: entry.title,
        summary: entry.summary,
        syntax: Array.isArray(entry.syntax) ? entry.syntax.slice(0, 4) : [],
        examples: Array.isArray(entry.examples) ? entry.examples.slice(0, 4) : [],
        source: entry.source,
    };
}

export function getGeoGebraManualIndexStatus() {
    const types = Array.from(new Set(manualEntries.map(entry => entry.type))).sort();
    return {
        ready: manualEntries.length > 0,
        entryCount: manualEntries.length,
        types,
    };
}

export function searchGeoGebraManual(query, limitValue = DEFAULT_LIMIT) {
    const tokens = normalizeQuery(query);
    if (tokens.length === 0) return [];

    const limit = normalizeManualSearchLimit(limitValue);
    return searchableEntries
        .map(entry => ({ entry, score: scoreEntry(entry, tokens) }))
        .filter(match => match.score > 0)
        .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            return left.entry.title.localeCompare(right.entry.title);
        })
        .slice(0, limit)
        .map(match => compactEntry(match.entry));
}
