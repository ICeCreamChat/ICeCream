const ASSIGNMENT_PATTERN = /^\s*([A-Za-z_]\w*)\s*=/;
const OBJECT_NAME_PATTERN = /^[A-Za-z_]\w*$/;

function unique(values = []) {
    return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function normalizeCommands(commands) {
    if (Array.isArray(commands)) {
        return commands.map(command => String(command || '').trim()).filter(Boolean);
    }
    return String(commands || '')
        .split(/\n|;/)
        .map(command => command.trim())
        .filter(Boolean);
}

function commandAssignmentLabels(commands = []) {
    return unique(normalizeCommands(commands).map(command => command.match(ASSIGNMENT_PATTERN)?.[1]));
}

function collectObjectsFromAction(action = {}, labels = []) {
    if (!action || typeof action !== 'object') return labels;
    if (action.kind === 'set-visible') {
        labels.push(...(Array.isArray(action.objects) ? action.objects : [action.object]));
    }
    if (action.kind === 'path-trace') {
        labels.push(action.movingObject, action.tracedObject);
    }
    if (action.kind === 'move-point') {
        labels.push(action.movingObject);
    }
    if (action.kind === 'command-at') {
        labels.push(...commandAssignmentLabels(action.commands || action.command));
    }
    return labels;
}

function collectObjectsFromInitialState(initialState = {}) {
    return unique([
        ...(Array.isArray(initialState.visible) ? initialState.visible : []),
        ...(Array.isArray(initialState.hidden) ? initialState.hidden : []),
    ]);
}

function collectObjectsFromDemo(demo = {}) {
    const labels = collectObjectsFromInitialState(demo.initialState);
    if (Array.isArray(demo.tracks)) {
        demo.tracks.forEach(track => collectObjectsFromAction(track, labels));
    }
    if (Array.isArray(demo.stages)) {
        demo.stages.forEach(stage => {
            (stage.actions || []).forEach(action => collectObjectsFromAction(action, labels));
        });
    }
    return unique(labels.filter(label => OBJECT_NAME_PATTERN.test(String(label || ''))));
}

function collectObjectsFromConstructionPlan(constructionPlan = []) {
    if (!Array.isArray(constructionPlan)) return [];
    const labels = [];
    constructionPlan.forEach(step => {
        if (Array.isArray(step?.objects)) labels.push(...step.objects);
    });
    return unique(labels.filter(label => OBJECT_NAME_PATTERN.test(String(label || ''))));
}

function collectCanvasObjectNames(canvasSnapshot = {}) {
    const items = [
        ...(Array.isArray(canvasSnapshot.objects) ? canvasSnapshot.objects : []),
        ...(Array.isArray(canvasSnapshot.elements) ? canvasSnapshot.elements : []),
        ...(Array.isArray(canvasSnapshot.expressions) ? canvasSnapshot.expressions : []),
    ];
    return new Set(items
        .map(item => String(item?.name || item?.label || '').trim())
        .filter(Boolean));
}

function collectCanvasAngles(canvasSnapshot = {}) {
    const items = Array.isArray(canvasSnapshot.objects) ? canvasSnapshot.objects : [];
    return items
        .filter(item => /angle/i.test(String(item?.type || '')) || /^[a-z]*alpha|beta|gamma|ang/i.test(String(item?.name || '')))
        .map(item => ({
            name: String(item.name || item.label || '').trim(),
            value: String(item.value || '').trim(),
        }))
        .filter(item => item.name);
}

function parseDegreeValue(value) {
    const match = String(value || '').match(/(-?\d+(?:\.\d+)?)\s*(?:°|deg|degrees?)/i);
    if (!match) return null;
    const number = Number(match[1]);
    return Number.isFinite(number) ? number : null;
}

function readAngleExpectations(planBody = {}, problemText = '') {
    const configured = [
        ...(Array.isArray(planBody.validation?.angles) ? planBody.validation.angles : []),
        ...(Array.isArray(planBody.checks?.angles) ? planBody.checks.angles : []),
    ];
    const expectations = configured
        .map(item => ({
            object: String(item?.object || item?.name || '').trim(),
            kind: String(item?.kind || item?.type || '').trim().toLowerCase(),
        }))
        .filter(item => item.object && item.kind);

    if (!expectations.length && /锐角|acute/i.test(String(problemText || ''))) {
        expectations.push({ object: '', kind: 'acute' });
    }
    return expectations;
}

function checkCommands(records = []) {
    if (!records.length) {
        return {
            id: 'commands',
            label: 'Command execution',
            status: 'warning',
            message: 'No command execution records were available.',
        };
    }
    const failed = records.filter(record => !record.success);
    if (failed.length) {
        return {
            id: 'commands',
            label: 'Command execution',
            status: 'failed',
            message: `${failed.length} command(s) failed. First: ${failed[0].command || failed[0].error || 'unknown command'}`,
        };
    }
    return {
        id: 'commands',
        label: 'Command execution',
        status: 'passed',
        message: `${records.length} command(s) executed successfully.`,
    };
}

function checkObjects(planBody = {}, canvasSnapshot = {}) {
    const references = collectPlanObjectReferences(planBody);
    const requiredLabels = unique([...references.commandLabels, ...references.constructionLabels]);
    const canvasNames = collectCanvasObjectNames(canvasSnapshot);
    if (!requiredLabels.length) {
        return {
            id: 'objects',
            label: 'Canvas objects',
            status: 'warning',
            message: 'No object labels were declared by commands or construction plan.',
        };
    }
    const missing = requiredLabels.filter(label => !canvasNames.has(label));
    if (missing.length) {
        return {
            id: 'objects',
            label: 'Canvas objects',
            status: 'failed',
            message: `Missing object(s): ${missing.slice(0, 8).join(', ')}`,
        };
    }
    return {
        id: 'objects',
        label: 'Canvas objects',
        status: 'passed',
        message: `${requiredLabels.length} key object(s) are present.`,
    };
}

function checkDemo(planBody = {}, demoConfig = null, canvasSnapshot = {}) {
    const sourceDemo = planBody.demo;
    if (!sourceDemo) {
        return {
            id: 'demo',
            label: 'Timeline demo',
            status: 'warning',
            message: 'No demo timeline was provided.',
        };
    }
    if (!demoConfig) {
        return {
            id: 'demo',
            label: 'Timeline demo',
            status: 'failed',
            message: 'Demo metadata was returned but could not be normalized.',
        };
    }
    const demoLabels = collectObjectsFromDemo(demoConfig);
    const canvasNames = collectCanvasObjectNames(canvasSnapshot);
    const missing = demoLabels.filter(label => !canvasNames.has(label));
    if (missing.length) {
        return {
            id: 'demo',
            label: 'Timeline demo',
            status: 'warning',
            message: `Demo references object(s) not currently visible in canvas snapshot: ${missing.slice(0, 8).join(', ')}`,
        };
    }
    return {
        id: 'demo',
        label: 'Timeline demo',
        status: 'passed',
        message: `${(demoConfig.stages || []).length || 1} stage(s) ready for playback.`,
    };
}

function checkViewport(planBody = {}, latestViewport = null) {
    if (!planBody.viewport?.equalScale) {
        return {
            id: 'viewport',
            label: 'Viewport scale',
            status: 'warning',
            message: 'No equal-scale viewport was requested.',
        };
    }
    if (!latestViewport?.equalScale) {
        return {
            id: 'viewport',
            label: 'Viewport scale',
            status: 'warning',
            message: 'Equal-scale viewport was requested but not confirmed after rendering.',
        };
    }
    return {
        id: 'viewport',
        label: 'Viewport scale',
        status: 'passed',
        message: 'Equal-scale viewport is active.',
    };
}

function checkConstructionPlan(planBody = {}) {
    if (!planBody.demo) {
        return {
            id: 'constructionPlan',
            label: 'Construction plan',
            status: 'warning',
            message: 'No classroom demo was requested.',
        };
    }
    if (!Array.isArray(planBody.constructionPlan) || !planBody.constructionPlan.length) {
        return {
            id: 'constructionPlan',
            label: 'Construction plan',
            status: 'warning',
            message: 'Demo exists but constructionPlan is missing.',
        };
    }
    return {
        id: 'constructionPlan',
        label: 'Construction plan',
        status: 'passed',
        message: `${planBody.constructionPlan.length} construction step(s) were provided.`,
    };
}

function checkAngles(planBody = {}, canvasSnapshot = {}, problemText = '') {
    const expectations = readAngleExpectations(planBody, problemText);
    if (!expectations.length) {
        return {
            id: 'angles',
            label: 'Angle sanity',
            status: 'passed',
            message: 'No angle-specific expectation was required.',
        };
    }
    const angles = collectCanvasAngles(canvasSnapshot);
    if (!angles.length) {
        return {
            id: 'angles',
            label: 'Angle sanity',
            status: 'warning',
            message: 'No rendered angle object was available for validation.',
        };
    }
    const failures = [];
    expectations.forEach(expectation => {
        const targetAngles = expectation.object
            ? angles.filter(angle => angle.name === expectation.object)
            : angles;
        targetAngles.forEach(angle => {
            const degrees = parseDegreeValue(angle.value);
            if (degrees === null) return;
            if (expectation.kind === 'acute' && !(degrees > 0 && degrees < 90)) {
                failures.push(`${angle.name}=${angle.value}`);
            }
            if (expectation.kind === 'nonreflex' && !(degrees >= 0 && degrees <= 180)) {
                failures.push(`${angle.name}=${angle.value}`);
            }
        });
    });
    if (failures.length) {
        return {
            id: 'angles',
            label: 'Angle sanity',
            status: 'failed',
            message: `Angle expectation failed: ${failures.slice(0, 4).join(', ')}`,
        };
    }
    return {
        id: 'angles',
        label: 'Angle sanity',
        status: 'passed',
        message: 'Angle values match the requested expectation.',
    };
}

export function collectPlanObjectReferences(planBody = {}) {
    const commandLabels = commandAssignmentLabels(planBody.commands);
    const demoLabels = collectObjectsFromDemo(planBody.demo);
    const constructionLabels = collectObjectsFromConstructionPlan(planBody.constructionPlan);
    return {
        commandLabels,
        demoLabels,
        constructionLabels,
        allLabels: unique([...commandLabels, ...demoLabels, ...constructionLabels]),
    };
}

export function runGeoGebraAutomatedCheck({
    planBody = {},
    records = [],
    canvasSnapshot = {},
    demoConfig = null,
    latestViewport = null,
    problemText = '',
} = {}) {
    const items = [
        checkCommands(records),
        checkObjects(planBody, canvasSnapshot),
        checkDemo(planBody, demoConfig, canvasSnapshot),
        checkConstructionPlan(planBody),
        checkViewport(planBody, latestViewport),
        checkAngles(planBody, canvasSnapshot, problemText),
    ];
    const status = items.some(item => item.status === 'failed')
        ? 'failed'
        : (items.some(item => item.status === 'warning') ? 'warning' : 'passed');
    const summary = status === 'failed'
        ? 'Automated check found issues; 自动化检查发现问题。'
        : (status === 'warning'
            ? 'Automated check passed with warnings; 自动化检查通过但有警告。'
            : 'Automated check passed; 自动化检查通过。');
    return { status, summary, items };
}
