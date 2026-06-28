import {
    applyAiLayoutMatrix,
    createClassroomLayout,
    layoutMatrix,
    parseClassroomLayoutPrompt,
} from '../../shared/seating/classroom-layout.js';

function intInRange(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

const MAX_LAYOUT_DIMENSION = Number.MAX_SAFE_INTEGER;

function booleanValue(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        if (/^(true|1|yes|on|启用|开启)$/i.test(value.trim())) return true;
        if (/^(false|0|no|off|关闭|禁用)$/i.test(value.trim())) return false;
    }
    return Boolean(value);
}

export function normalizePlanRequest(body = {}) {
    const promptDefaults = parseClassroomLayoutPrompt(body.prompt || '');
    return {
        rows: intInRange(body.rows, 6, 1, MAX_LAYOUT_DIMENSION),
        cols: intInRange(body.cols, 8, 1, MAX_LAYOUT_DIMENSION),
        template: body.template || promptDefaults.template || 'standard',
        groupSize: intInRange(body.groupSize ?? promptDefaults.groupSize, promptDefaults.groupSize || 1, 1, 8),
        guardiansEnabled: booleanValue(body.guardiansEnabled, promptDefaults.guardiansEnabled),
        prompt: String(body.prompt || ''),
    };
}

export function buildSeatingPlanResponse({
    rows,
    cols,
    matrix,
    reasoning = '',
    groupSize = 1,
    guardiansEnabled = false,
    template = 'custom',
}) {
    const layout = matrix
        ? applyAiLayoutMatrix({ rows, cols, matrix, groupSize, guardiansEnabled })
        : createClassroomLayout({ rows, cols, template, groupSize, guardiansEnabled });
    return {
        matrix: layoutMatrix(layout),
        reasoning,
        layout,
        groups: layout.groups,
    };
}
