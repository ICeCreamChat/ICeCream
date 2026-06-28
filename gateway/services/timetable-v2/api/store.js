/**
 * timetable-v2 / api / store.js
 *
 * V2 项目持久化：独立存储键，与旧 timetable 数据完全隔离。
 * 决策 4：旧项目数据只读不改，V2 草稿写独立键（data/timetable-v2/），迁移不覆盖原数据。
 *
 * 原子写（tmp + rename）沿用旧 timetable-store 模式。
 */

import { mkdir, readFile, rename, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

import { gatewayPaths } from '../../../config/paths.js';
import { createProject } from '../domain/project.js';

function defaultDataDir() {
    // 独立目录，绝不与旧 data/timetable 混用
    return process.env.TIMETABLE_V2_DATA_DIR || path.join(gatewayPaths.projectRoot, 'data', 'timetable-v2');
}

export function createTimetableV2Store(options = {}) {
    const dataDir = options.dataDir || defaultDataDir();
    const filename = options.filename || 'project.json';
    const filePath = path.join(dataDir, filename);

    async function loadRecord() {
        try {
            const raw = await readFile(filePath, 'utf8');
            return JSON.parse(raw);
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw new Error(`读取 V2 排课数据失败：${error.message}`);
        }
    }

    /** 读取 V2 项目；不存在返回 null（区别于"默认空项目"，调用方决定是否触发迁移）。 */
    async function loadProject() {
        const parsed = await loadRecord();
        return parsed?.project ?? null;
    }

    /** 是否已存在 V2 草稿（迁移幂等判断用）。 */
    async function exists() {
        try {
            await access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    /** 保存 V2 项目（经 createProject 校验，保证结构合法）。原子写。 */
    async function saveProject(rawProject, options = {}) {
        const validated = createProject(rawProject); // 校验失败抛错，不写
        const currentRecord = await loadRecord();
        const currentRevision = normalizeRevision(currentRecord?.project?.revision ?? currentRecord?.revision, 0);
        const expectedRevision = normalizeOptionalRevision(
            options.expectedRevision ?? rawProject?.expectedRevision ?? rawProject?.revision,
        );
        if (currentRecord && expectedRevision === null) {
            throw versionConflict('项目已存在，保存时必须携带当前 revision', {
                currentRevision,
                expectedRevision: null,
            });
        }
        if (currentRecord && expectedRevision !== currentRevision) {
            throw versionConflict('项目已被其他窗口修改，请刷新后重试', {
                currentRevision,
                expectedRevision,
            });
        }

        const nextRevision = currentRecord ? currentRevision + 1 : 1;
        const now = new Date().toISOString();
        const project = preserveProjectExtras(rawProject, {
            ...validated,
            revision: nextRevision,
            updatedAt: now,
        });
        await mkdir(dataDir, { recursive: true });
        const payload = JSON.stringify({
            version: 2,
            revision: nextRevision,
            updatedAt: now,
            project,
        }, null, 2);
        const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        await writeFile(tmpPath, payload, 'utf8');
        await rename(tmpPath, filePath);
        return project;
    }

    return { dataDir, filePath, loadProject, saveProject, exists };
}

export const timetableV2Store = createTimetableV2Store();

function normalizeRevision(value, fallback) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function normalizeOptionalRevision(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

function versionConflict(message, data) {
    const error = new Error(message);
    error.statusCode = 409;
    error.data = { reason: 'version_conflict', ...data };
    return error;
}

function preserveProjectExtras(source = {}, target = {}) {
    const out = { ...target };
    for (const key of ['metadata', 'publishedHistory', 'publishedSnapshot']) {
        if (source[key] !== undefined) out[key] = cloneJson(source[key]);
    }
    return out;
}

function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
