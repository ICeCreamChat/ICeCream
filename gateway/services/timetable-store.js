import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { gatewayPaths } from '../config/paths.js';
import { createDefaultTimetableProject, normalizeTimetableProject } from './timetable-scheduler.js';

function getDefaultDataDir() {
    return process.env.TIMETABLE_DATA_DIR || path.join(gatewayPaths.projectRoot, 'data', 'timetable');
}

export function createTimetableStore(options = {}) {
    const dataDir = options.dataDir || getDefaultDataDir();
    const filename = options.filename || 'projects.json';
    const filePath = path.join(dataDir, filename);

    async function loadProject() {
        try {
            const raw = await readFile(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            return normalizeTimetableProject(parsed?.project || parsed);
        } catch (error) {
            if (error.code === 'ENOENT') return createDefaultTimetableProject();
            throw new Error(`读取排课数据失败：${error.message}`);
        }
    }

    async function saveProject(project) {
        await mkdir(dataDir, { recursive: true });
        const normalized = normalizeTimetableProject({
            ...project,
            updatedAt: new Date().toISOString(),
        });
        const payload = JSON.stringify({ version: 1, project: normalized }, null, 2);
        const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        await writeFile(tmpPath, payload, 'utf8');
        await rename(tmpPath, filePath);
        return normalized;
    }

    return {
        dataDir,
        filePath,
        loadProject,
        saveProject,
    };
}

export const timetableStore = createTimetableStore();
