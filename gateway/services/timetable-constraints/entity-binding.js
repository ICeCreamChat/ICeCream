import { normalizeTimetableProject } from '../timetable-project.js';

const COLLECTIONS = {
    teacher: 'teachers',
    class: 'classes',
    subject: 'subjects',
    room: 'rooms',
};

function clean(value, max = 120) {
    return String(value ?? '').trim().slice(0, max);
}

export function applyConstraintEntityBindings(project = {}, bindings = []) {
    const normalized = normalizeTimetableProject(project);
    const aliases = structuredClone(normalized.constraintEntityAliases || {});
    for (const binding of Array.isArray(bindings) ? bindings : []) {
        const kind = clean(binding?.kind, 20).toLowerCase();
        const sourceName = clean(binding?.sourceName);
        const targetId = clean(binding?.targetId, 80);
        const collection = COLLECTIONS[kind];
        if (!collection || !sourceName || !targetId) {
            const error = new Error('实体绑定缺少合法的 kind、sourceName 或 targetId。');
            error.reason = 'invalid_entity_binding';
            error.status = 400;
            throw error;
        }
        if (!(normalized[collection] || []).some(item => item.id === targetId)) {
            const error = new Error(`绑定目标 ${targetId} 不存在于当前项目。`);
            error.reason = 'entity_binding_target_not_found';
            error.status = 400;
            throw error;
        }
        aliases[kind] = { ...(aliases[kind] || {}), [sourceName]: targetId };
    }
    return normalizeTimetableProject({ ...normalized, constraintEntityAliases: aliases });
}

export function findInvalidConstraintEntityAliases(project = {}, nextCollections = {}) {
    const aliases = project.constraintEntityAliases || {};
    const invalid = [];
    for (const [kind, collection] of Object.entries(COLLECTIONS)) {
        const ids = new Set((nextCollections[collection] || []).map(item => item?.id).filter(Boolean));
        for (const [sourceName, targetId] of Object.entries(aliases[kind] || {})) {
            if (!ids.has(targetId)) invalid.push({ kind, sourceName, targetId });
        }
    }
    return invalid;
}
