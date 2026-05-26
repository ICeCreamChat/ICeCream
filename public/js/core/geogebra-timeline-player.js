const DEMO_NUMBER_PATTERN = '[-+]?\\d+(?:\\.\\d+)?';

function readFiniteDemoNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function normalizeParametricExpression(expression) {
    const text = String(expression || '').trim();
    if (!text || text.length > 120) return '';
    const normalized = text
        .replace(/\b(sin|cos|tan|asin|acos|atan|sqrt|abs|min|max|pow)\b/g, 'Math.$1')
        .replace(/\bPI\b/g, 'Math.PI')
        .replace(/\bE\b/g, 'Math.E');
    if (!/^[0-9t+\-*/().,\sMathPIEinscoqrtabmpw]+$/.test(normalized)) return '';
    const identifiers = normalized.match(/[A-Za-z_$][\w$]*/g) || [];
    const allowed = new Set(['t', 'Math', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sqrt', 'abs', 'min', 'max', 'pow', 'PI', 'E']);
    if (identifiers.some(identifier => !allowed.has(identifier))) return '';
    return normalized;
}

function evaluateParametricExpression(expression, t) {
    try {
        const evaluator = new Function('t', 'Math', `"use strict"; return Number(${expression});`);
        const value = evaluator(t, Math);
        return Number.isFinite(value) ? value : 0;
    } catch {
        return 0;
    }
}

function normalizeTimelineNumber(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(Math.max(number, min), max);
}

function normalizeCommands(commands) {
    if (Array.isArray(commands)) {
        return commands.map(command => String(command || '').trim()).filter(Boolean).slice(0, 120);
    }
    return String(commands || '')
        .split(/\n|;/)
        .map(command => command.trim())
        .filter(Boolean)
        .slice(0, 120);
}

function normalizeObjects(objects, limit = 80) {
    if (!Array.isArray(objects)) return [];
    return objects.map(objectName => String(objectName || '').trim()).filter(Boolean).slice(0, limit);
}

export function normalizeDemoPath(path = {}) {
    if (!path || typeof path !== 'object') return null;
    if (path.type === 'circle') {
        const centerX = readFiniteDemoNumber(path.center?.x);
        const centerY = readFiniteDemoNumber(path.center?.y);
        const radius = readFiniteDemoNumber(path.radius);
        if (centerX === null || centerY === null || radius === null || radius <= 0) return null;
        return {
            type: 'circle',
            center: { x: centerX, y: centerY },
            radius,
            startAngle: readFiniteDemoNumber(path.startAngle) ?? -90,
            endAngle: readFiniteDemoNumber(path.endAngle) ?? 270,
        };
    }
    if (path.type === 'segment') {
        const fromX = readFiniteDemoNumber(path.from?.x);
        const fromY = readFiniteDemoNumber(path.from?.y);
        const toX = readFiniteDemoNumber(path.to?.x);
        const toY = readFiniteDemoNumber(path.to?.y);
        if ([fromX, fromY, toX, toY].some(value => value === null)) return null;
        return { type: 'segment', from: { x: fromX, y: fromY }, to: { x: toX, y: toY } };
    }
    if (path.type === 'polyline') {
        const points = Array.isArray(path.points)
            ? path.points.map(point => {
                const x = readFiniteDemoNumber(point?.x);
                const y = readFiniteDemoNumber(point?.y);
                return x === null || y === null ? null : { x, y };
            }).filter(Boolean)
            : [];
        return points.length >= 2 ? { type: 'polyline', points: points.slice(0, 80) } : null;
    }
    if (path.type === 'parametric') {
        const xExpression = normalizeParametricExpression(path.xExpression);
        const yExpression = normalizeParametricExpression(path.yExpression);
        if (!xExpression || !yExpression) return null;
        return { type: 'parametric', xExpression, yExpression };
    }
    return null;
}

export function formatGeoGebraNumber(value) {
    if (!Number.isFinite(value)) return '0';
    return String(Number(value.toFixed(8)));
}

export function pointOnDemoPath(path, progress) {
    if (!path) return null;
    const clampedProgress = Math.min(Math.max(progress, 0), 1);
    if (path.type === 'circle') {
        const startRadians = path.startAngle * Math.PI / 180;
        const endRadians = path.endAngle * Math.PI / 180;
        const angle = startRadians + (endRadians - startRadians) * clampedProgress;
        return {
            x: path.center.x + path.radius * Math.cos(angle),
            y: path.center.y + path.radius * Math.sin(angle),
        };
    }
    if (path.type === 'segment') {
        return {
            x: path.from.x + (path.to.x - path.from.x) * clampedProgress,
            y: path.from.y + (path.to.y - path.from.y) * clampedProgress,
        };
    }
    if (path.type === 'polyline') {
        const scaled = clampedProgress * (path.points.length - 1);
        const index = Math.min(Math.floor(scaled), path.points.length - 2);
        const localProgress = scaled - index;
        const from = path.points[index];
        const to = path.points[index + 1];
        return {
            x: from.x + (to.x - from.x) * localProgress,
            y: from.y + (to.y - from.y) * localProgress,
        };
    }
    if (path.type === 'parametric') {
        return {
            x: evaluateParametricExpression(path.xExpression, clampedProgress),
            y: evaluateParametricExpression(path.yExpression, clampedProgress),
        };
    }
    return null;
}

export function buildSetPointCommand(movingObject, x, y) {
    return `SetValue(${movingObject}, (${formatGeoGebraNumber(x)}, ${formatGeoGebraNumber(y)}))`;
}

export function normalizeTimelineTrack(track = {}, timelineDurationMs = 8000) {
    if (!track || typeof track !== 'object') return null;
    if (track.kind === 'path-trace') {
        const movingObject = String(track.movingObject || '').trim();
        const tracedObject = String(track.tracedObject || '').trim();
        const path = normalizeDemoPath(track.path);
        if (!movingObject || !tracedObject || !path) return null;
        return {
            kind: 'path-trace',
            movingObject,
            tracedObject,
            path,
            startMs: normalizeTimelineNumber(track.startMs, 0, 0, timelineDurationMs),
            endMs: normalizeTimelineNumber(track.endMs, timelineDurationMs, 0, timelineDurationMs),
            samples: Math.round(normalizeTimelineNumber(track.samples, 240, 24, 600)),
        };
    }
    if (track.kind === 'command-at') {
        const commands = normalizeCommands(track.commands || track.command);
        if (!commands.length) return null;
        return {
            kind: 'command-at',
            timeMs: normalizeTimelineNumber(track.timeMs, 0, 0, timelineDurationMs),
            commands,
        };
    }
    if (track.kind === 'set-visible') {
        const objects = normalizeObjects(track.objects || [track.object], 20);
        if (!objects.length) return null;
        return {
            kind: 'set-visible',
            timeMs: normalizeTimelineNumber(track.timeMs, 0, 0, timelineDurationMs),
            objects,
            visible: track.visible !== false,
        };
    }
    return null;
}

function normalizeInitialState(initialState = {}) {
    return {
        visible: normalizeObjects(initialState.visible, 120),
        hidden: normalizeObjects(initialState.hidden, 120),
    };
}

function normalizeStageAction(action = {}, stageDurationMs = 1800) {
    const normalized = normalizeTimelineTrack(action, stageDurationMs);
    return normalized;
}

function normalizeStage(stage = {}, index = 0) {
    const durationMs = normalizeTimelineNumber(stage.durationMs, 1800, 400, 30000);
    const actions = Array.isArray(stage.actions)
        ? stage.actions.map(action => normalizeStageAction(action, durationMs)).filter(Boolean).slice(0, 16)
        : [];
    return {
        id: String(stage.id || `stage-${index + 1}`).slice(0, 80),
        title: String(stage.title || `阶段 ${index + 1}`).slice(0, 80),
        summary: String(stage.summary || '').slice(0, 240),
        durationMs,
        actions,
    };
}

function buildLegacyStage(tracks, durationMs) {
    return {
        id: 'motion',
        title: '动态观察',
        summary: '观察动点运动和相关对象变化。',
        durationMs,
        actions: tracks,
    };
}

function flattenStageActions(stages) {
    const flattened = [];
    let cursor = 0;
    stages.forEach(stage => {
        stage.actions.forEach(action => {
            if (action.kind === 'path-trace') {
                flattened.push({
                    ...action,
                    startMs: cursor + (action.startMs || 0),
                    endMs: cursor + (action.endMs || stage.durationMs),
                });
            } else {
                flattened.push({
                    ...action,
                    timeMs: cursor + (action.timeMs || 0),
                });
            }
        });
        cursor += stage.durationMs;
    });
    return flattened;
}

export function normalizeTimelineDemo(demo = {}) {
    if (!demo || typeof demo !== 'object') return null;
    if (demo.type === 'trace') {
        const durationMs = normalizeTimelineNumber(demo.durationMs, 6500, 1200, 30000);
        const track = normalizeTimelineTrack({
            kind: 'path-trace',
            movingObject: demo.movingObject,
            tracedObject: demo.tracedObject,
            path: demo.path,
            samples: demo.frameCount || demo.samples || 240,
        }, durationMs);
        if (!track) return null;
        const stages = [buildLegacyStage([track], durationMs)];
        return {
            type: 'timeline',
            mode: 'construction',
            autoPlay: demo.autoPlay === true,
            clearBeforePlay: true,
            preserveAfterFinish: true,
            durationMs,
            initialState: normalizeInitialState(demo.initialState),
            stages,
            tracks: flattenStageActions(stages),
        };
    }
    if (demo.type !== 'timeline') return null;

    const legacyDurationMs = normalizeTimelineNumber(demo.durationMs, 8000, 1200, 30000);
    const legacyTracks = Array.isArray(demo.tracks)
        ? demo.tracks.map(track => normalizeTimelineTrack(track, legacyDurationMs)).filter(Boolean).slice(0, 12)
        : [];
    const stages = Array.isArray(demo.stages)
        ? demo.stages.map((stage, index) => normalizeStage(stage, index)).filter(stage => stage.actions.length).slice(0, 12)
        : [];
    const normalizedStages = stages.length ? stages : (legacyTracks.length ? [buildLegacyStage(legacyTracks, legacyDurationMs)] : []);
    if (!normalizedStages.length) return null;
    const durationMs = normalizedStages.reduce((sum, stage) => sum + stage.durationMs, 0);
    return {
        type: 'timeline',
        mode: demo.mode === 'construction' ? 'construction' : 'construction',
        autoPlay: demo.autoPlay === true,
        clearBeforePlay: demo.clearBeforePlay !== false,
        preserveAfterFinish: demo.preserveAfterFinish !== false,
        durationMs,
        initialState: normalizeInitialState(demo.initialState),
        stages: normalizedStages,
        tracks: flattenStageActions(normalizedStages),
    };
}

export function buildInitialStateCommands(initialState = {}) {
    const state = normalizeInitialState(initialState);
    return [
        ...state.visible.map(objectName => `SetVisibleInView(${objectName}, 1, true)`),
        ...state.hidden.map(objectName => `SetVisibleInView(${objectName}, 1, false)`),
    ];
}

export function buildRevealAllCommands(timeline = {}) {
    const hidden = normalizeObjects(timeline.initialState?.hidden, 120);
    return hidden.map(objectName => `SetVisibleInView(${objectName}, 1, true)`);
}

export function tracedObjectsFromTimeline(timeline = {}) {
    return [...new Set((timeline.tracks || [])
        .filter(track => track.kind === 'path-trace')
        .map(track => track.tracedObject)
        .filter(Boolean))];
}

export { DEMO_NUMBER_PATTERN };
