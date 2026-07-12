import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { gatewayPaths } from '../../config/paths.js';

const DEFAULT_MAX_ITEMS = 40;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_FILENAME = 'constraint-parse-cache.json';
const sharedCaches = new Map();

function clone(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function dataDirFor(env = process.env) {
    return env.TIMETABLE_DATA_DIR || path.join(gatewayPaths.projectRoot, 'data', 'timetable');
}

function validEntry(entry = {}, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
    const createdAt = Date.parse(entry.createdAt || '');
    return Number.isFinite(createdAt) && now - createdAt <= ttlMs && entry.value && typeof entry.value === 'object';
}

export function createTimetableConstraintParseCache(options = {}) {
    const dataDir = options.dataDir || dataDirFor(options.env);
    const filePath = options.filePath || path.join(dataDir, CACHE_FILENAME);
    const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0 ? options.maxItems : DEFAULT_MAX_ITEMS;
    const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
    const entries = new Map();
    const inFlight = new Map();
    let loaded = false;
    let loading = null;

    async function load() {
        if (loaded) return;
        if (loading) return loading;
        loading = (async () => {
            try {
                const payload = JSON.parse(await readFile(filePath, 'utf8'));
                const now = Date.now();
                for (const item of Array.isArray(payload.entries) ? payload.entries : []) {
                    if (!item?.key || !validEntry(item, now, ttlMs)) continue;
                    entries.set(item.key, { createdAt: item.createdAt, value: item.value });
                }
            } catch (error) {
                if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
            } finally {
                loaded = true;
                loading = null;
            }
        })();
        return loading;
    }

    function prune() {
        const now = Date.now();
        for (const [key, entry] of entries) {
            if (!validEntry(entry, now, ttlMs)) entries.delete(key);
        }
        while (entries.size > maxItems) entries.delete(entries.keys().next().value);
    }

    async function persist() {
        prune();
        await mkdir(dataDir, { recursive: true });
        const payload = JSON.stringify({
            version: 1,
            entries: [...entries].map(([key, entry]) => ({ key, ...entry })),
        });
        const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        await writeFile(tmpPath, payload, 'utf8');
        await rename(tmpPath, filePath);
    }

    async function get(key = '') {
        if (!key) return null;
        await load();
        const entry = entries.get(key);
        if (!validEntry(entry, Date.now(), ttlMs)) {
            if (entry) entries.delete(key);
            return null;
        }
        entries.delete(key);
        entries.set(key, entry);
        return clone(entry.value);
    }

    async function set(key = '', value = null) {
        if (!key || !value) return;
        await load();
        entries.delete(key);
        entries.set(key, { createdAt: new Date().toISOString(), value: clone(value) });
        prune();
        await persist();
    }

    async function getOrCreate(key = '', producer, options = {}) {
        let cached = null;
        try {
            cached = await get(key);
        } catch {
            cached = null;
        }
        if (cached) return { value: cached, cacheHit: true, coalesced: false };
        if (inFlight.has(key)) {
            return { value: clone(await inFlight.get(key)), cacheHit: true, coalesced: true };
        }
        const task = (async () => {
            const value = await producer();
            const admitted = typeof options.shouldCache !== 'function' || options.shouldCache(value) !== false;
            if (admitted) {
                try {
                    await set(key, value);
                } catch {
                    // Cache I/O is best-effort and must not invalidate a successful parse.
                }
            }
            return value;
        })();
        inFlight.set(key, task);
        try {
            return { value: clone(await task), cacheHit: false, coalesced: false };
        } finally {
            if (inFlight.get(key) === task) inFlight.delete(key);
        }
    }

    return { dataDir, filePath, get, set, getOrCreate };
}

export function getTimetableConstraintParseCache(env = process.env) {
    const dataDir = dataDirFor(env);
    if (!sharedCaches.has(dataDir)) {
        sharedCaches.set(dataDir, createTimetableConstraintParseCache({ dataDir }));
    }
    return sharedCaches.get(dataDir);
}
