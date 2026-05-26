import fetch from 'node-fetch';

import { searchGeoGebraCommands } from './command-search.js';
import { tryCreateDeterministicGeoGebraPlan } from './geogebra-deterministic-plans.js';
import { GEOGEBRA_SYSTEM_PROMPT } from './geogebra-prompt.js';
import { searchGeoGebraManual } from './manual-search.js';
import { classifyGeoGebraProblem, extractGeoGebraFacts } from './problem-types.js';

const MAX_MESSAGE_LENGTH = 4000;
const MAX_CANVAS_ITEMS = 80;
const MAX_SELECTED_OBJECTS = 20;
const MAX_COMMANDS = 32;
const MAX_COMMAND_LENGTH = 500;
const ALLOWED_PERSPECTIVES = new Set(['G', 'T', 'A', 'B']);

const CHINESE_COMMAND_HINTS = [
    { pattern: /圆|外接圆|内切圆|半径|圆心/, query: 'Circle' },
    { pattern: /三角形|多边形|四边形|正方形|矩形/, query: 'Polygon' },
    { pattern: /点|顶点|坐标/, query: 'Point' },
    { pattern: /直线|线段|边/, query: 'Line Segment' },
    { pattern: /垂直|垂线|垂足/, query: 'PerpendicularLine' },
    { pattern: /平行|平行线/, query: 'Line ParallelLine' },
    { pattern: /中点|中垂线/, query: 'Midpoint PerpendicularBisector' },
    { pattern: /交点|相交/, query: 'Intersect' },
    { pattern: /椭圆/, query: 'Ellipse' },
    { pattern: /双曲线/, query: 'Hyperbola' },
    { pattern: /抛物线/, query: 'Parabola' },
    { pattern: /滑块|参数|动态/, query: 'Slider' },
    { pattern: /函数|曲线|图像/, query: 'Function' },
    { pattern: /导数|切线/, query: 'Derivative Tangent' },
    { pattern: /向量/, query: 'Vector' },
];

const GEOGEBRA_COMMAND_HINTS = [
    ...CHINESE_COMMAND_HINTS,
    { pattern: /圆|外接圆|内切圆|半径|圆心|circle/i, query: 'Circle' },
    { pattern: /三角形|多边形|四边形|正方形|矩形|triangle|polygon/i, query: 'Polygon' },
    { pattern: /点|顶点|坐标|point/i, query: 'Point' },
    { pattern: /直线|线段|弦|line|segment/i, query: 'Line Segment' },
    { pattern: /垂直|垂线|垂足|perpendicular/i, query: 'PerpendicularLine' },
    { pattern: /平行|平行线|parallel/i, query: 'Line ParallelLine' },
    { pattern: /中点|中垂线|midpoint/i, query: 'Midpoint PerpendicularBisector' },
    { pattern: /交点|相交|intersect/i, query: 'Intersect' },
    { pattern: /轨迹|locus/i, query: 'Locus Curve' },
    { pattern: /椭圆|ellipse/i, query: 'Ellipse' },
    { pattern: /双曲线|hyperbola/i, query: 'Hyperbola' },
    { pattern: /抛物线|parabola/i, query: 'Parabola' },
    { pattern: /滑块|参数|动态|slider/i, query: 'Slider' },
    { pattern: /函数|曲线|图像|function|graph/i, query: 'Function Curve' },
    { pattern: /导数|切线|tangent/i, query: 'Derivative Tangent' },
    { pattern: /向量|vector/i, query: 'Vector' },
];

export function hasGeoGebraAiConfig(env = process.env) {
    return Boolean(env.DEEPSEEK_API_BASE && env.DEEPSEEK_API_KEY && !String(env.DEEPSEEK_API_KEY).includes('your_'));
}

function normalizePerspective(value) {
    const perspective = String(value || 'G').trim().toUpperCase();
    return ALLOWED_PERSPECTIVES.has(perspective) ? perspective : 'G';
}

function compactCanvasItem(item) {
    if (!item || typeof item !== 'object') return null;
    const compactItem = {};
    for (const key of ['name', 'label', 'type', 'command', 'definition', 'value', 'text']) {
        if (item[key] !== undefined && item[key] !== null) {
            compactItem[key] = String(item[key]).slice(0, 240);
        }
    }
    if (item.coords && typeof item.coords === 'object') {
        compactItem.coords = item.coords;
    }
    return Object.keys(compactItem).length > 0 ? compactItem : null;
}

function compactCanvas(canvas = {}) {
    const objectItems = Array.isArray(canvas.objects) ? canvas.objects : [];
    const elementItems = Array.isArray(canvas.elements) ? canvas.elements : [];
    const expressionItems = Array.isArray(canvas.expressions) ? canvas.expressions : [];
    const commandItems = Array.isArray(canvas.commands) ? canvas.commands : [];

    return {
        elements: [...objectItems, ...elementItems].map(compactCanvasItem).filter(Boolean).slice(0, MAX_CANVAS_ITEMS),
        expressions: expressionItems.map(compactCanvasItem).filter(Boolean).slice(0, MAX_CANVAS_ITEMS),
        commands: commandItems.map(compactCanvasItem).filter(Boolean).slice(0, MAX_CANVAS_ITEMS),
    };
}

function normalizeSelectedObjects(selectedObjects) {
    const sourceItems = Array.isArray(selectedObjects) ? selectedObjects : [];
    return sourceItems
        .map(item => {
            if (item && typeof item === 'object') {
                return compactCanvasItem(item);
            }
            return String(item || '').trim();
        })
        .filter(Boolean)
        .slice(0, MAX_SELECTED_OBJECTS);
}

export function buildGeoGebraPlanRequest(body = {}) {
    const message = String(body.message || '').trim();
    if (!message) {
        const emptyMessageError = new Error('请描述想要生成的 GeoGebra 动态几何');
        emptyMessageError.status = 400;
        throw emptyMessageError;
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
        const longMessageError = new Error(`GeoGebra 请求过长，请限制在 ${MAX_MESSAGE_LENGTH} 字符以内`);
        longMessageError.status = 400;
        throw longMessageError;
    }

    return {
        message,
        canvas: compactCanvas(body.canvas),
        selectedObjects: normalizeSelectedObjects(body.selectedObjects),
        preferredPerspective: normalizePerspective(body.preferredPerspective),
    };
}

export function buildGeoGebraRepairRequest(body = {}) {
    const planRequest = buildGeoGebraPlanRequest({
        message: body.message || '修复上一条 GeoGebra 命令',
        canvas: body.canvas,
        selectedObjects: body.selectedObjects,
        preferredPerspective: body.preferredPerspective,
    });
    const commandHistory = Array.isArray(body.commandHistory) ? body.commandHistory : [];
    return {
        ...planRequest,
        commandHistory: commandHistory
            .map(entry => ({
                command: String(entry?.command || '').slice(0, MAX_COMMAND_LENGTH),
                success: Boolean(entry?.success),
                label: String(entry?.label || '').slice(0, 80),
                error: String(entry?.error || '').slice(0, 240),
            }))
            .slice(-MAX_COMMANDS),
        failedCommand: {
            command: String(body.failedCommand?.command || '').slice(0, MAX_COMMAND_LENGTH),
            error: String(body.failedCommand?.error || '').slice(0, 240),
        },
    };
}

function normalizeCommandHistory(commandHistory) {
    const sourceItems = Array.isArray(commandHistory) ? commandHistory : [];
    return sourceItems
        .map(entry => ({
            command: String(entry?.command || '').slice(0, MAX_COMMAND_LENGTH),
            success: Boolean(entry?.success),
            label: String(entry?.label || '').slice(0, 80),
            error: String(entry?.error || '').slice(0, 240),
        }))
        .slice(-MAX_COMMANDS);
}

export function buildGeoGebraStudioAdjustRequest(body = {}) {
    const planRequest = buildGeoGebraPlanRequest(body);
    return {
        ...planRequest,
        commandHistory: normalizeCommandHistory(body.commandHistory),
    };
}

export function buildGeoGebraAgentStepRequest(body = {}) {
    const message = String(body.message || '').trim();
    if (!message) {
        const emptyMessageError = new Error('请描述 GeoGebra Studio 下一步需要绘制或调整什么');
        emptyMessageError.status = 400;
        throw emptyMessageError;
    }
    const planRequest = buildGeoGebraPlanRequest({
        message,
        canvas: body.canvas,
        selectedObjects: body.selectedObjects,
        preferredPerspective: body.preferredPerspective,
    });
    return {
        ...planRequest,
        commandHistory: normalizeCommandHistory(body.commandHistory),
        problem: {
            classification: classifyGeoGebraProblem(message),
            facts: extractGeoGebraFacts(message),
        },
    };
}

function isSafeGeoGebraCommand(command) {
    const trimmedCommand = String(command || '').trim();
    if (!trimmedCommand || trimmedCommand.length > MAX_COMMAND_LENGTH) return false;
    // Block script injection
    if (/(RunClickScript|RunUpdateScript|SetGlobalJavaScript|javascript:|ggbApplet|document\.|window\.|fetch\(|XMLHttpRequest|<script|eval\(|Function\(|localStorage|sessionStorage|cookie)/i.test(trimmedCommand)) {
        return false;
    }
    // Reject pure natural language (no assignment, no function call, no coordinate)
    // A valid command has at least one of: X = ..., Func(...), or (x, y)
    if (!/[=()]/i.test(trimmedCommand)) return false;
    // Reject markdown formatting
    if (/^[#*`>-]/.test(trimmedCommand)) return false;
    // Reject lines that are pure Chinese commentary
    if (/^[\u4e00-\u9fff\s\uff0c\u3002\uff1a\uff1b\u3001\uff08\uff09]+$/.test(trimmedCommand)) return false;
    return true;
}

function extractJsonObject(text) {
    const normalizedText = String(text || '').replace(/```json|```/gi, '').trim();
    const jsonMatch = normalizedText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
    }
    // Attempt to repair truncated JSON (AI output cut off by token limit)
    const truncatedMatch = normalizedText.match(/\{[\s\S]+/);
    if (truncatedMatch) {
        const repaired = repairTruncatedJson(truncatedMatch[0]);
        if (repaired) return repaired;
    }
    throw new Error('GeoGebra Agent 没有返回 JSON');
}

/**
 * Attempt to parse truncated JSON by closing unclosed brackets/braces.
 * This handles the common case where AI output is cut off mid-stream by token limits,
 * resulting in valid JSON prefix followed by an abrupt end.
 */
function repairTruncatedJson(text) {
    let candidate = text.trim();
    // Remove trailing incomplete string (unmatched quote)
    candidate = candidate.replace(/,\s*"[^"]*$/, '');
    // Remove trailing comma
    candidate = candidate.replace(/,\s*$/, '');
    // Close unclosed brackets and braces
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let i = 0; i < candidate.length; i++) {
        const ch = candidate[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') stack.pop();
    }
    // If still inside a string, close it
    if (inString) candidate += '"';
    // Close all open brackets/braces in reverse order
    while (stack.length) candidate += stack.pop();
    try {
        return JSON.parse(candidate);
    } catch {
        return null;
    }
}

function normalizeViewport(viewport) {
    if (!viewport || typeof viewport !== 'object') return undefined;
    const xmin = Number(viewport.xmin);
    const ymin = Number(viewport.ymin);
    const xmax = Number(viewport.xmax);
    const ymax = Number(viewport.ymax);
    if (![xmin, ymin, xmax, ymax].every(Number.isFinite)) return undefined;
    if (xmin >= xmax || ymin >= ymax) return undefined;
    return {
        xmin,
        ymin,
        xmax,
        ymax,
        equalScale: Boolean(viewport.equalScale),
    };
}

function normalizeFacts(facts) {
    if (!facts || typeof facts !== 'object') return undefined;
    return {
        objects: Array.isArray(facts.objects) ? facts.objects.map(String).slice(0, 40) : [],
        constraints: Array.isArray(facts.constraints) ? facts.constraints.map(String).slice(0, 40) : [],
        goals: Array.isArray(facts.goals) ? facts.goals.map(String).slice(0, 20) : [],
        uncertainties: Array.isArray(facts.uncertainties) ? facts.uncertainties.map(String).slice(0, 20) : [],
    };
}

const ALLOWED_DEMO_TRACK_KINDS = new Set(['path-trace', 'command-at', 'set-visible']);
const MAX_DEMO_DURATION = 30000;

function normalizeDemoStringArray(values, limit = 80) {
    if (!Array.isArray(values)) return [];
    return values.map(value => String(value || '').trim()).filter(Boolean).slice(0, limit);
}

function normalizeDemoInitialState(initialState = {}) {
    return {
        visible: normalizeDemoStringArray(initialState.visible, 120),
        hidden: normalizeDemoStringArray(initialState.hidden, 120),
    };
}

function normalizeDemoStage(stage = {}, index = 0) {
    if (!stage || typeof stage !== 'object') return null;
    const durationMs = Number(stage.durationMs);
    const actions = Array.isArray(stage.actions)
        ? stage.actions.filter(action => action && ALLOWED_DEMO_TRACK_KINDS.has(action.kind)).slice(0, 16)
        : [];
    if (!actions.length) return null;
    return {
        id: String(stage.id || `stage-${index + 1}`).slice(0, 80),
        title: String(stage.title || `阶段 ${index + 1}`).slice(0, 80),
        summary: String(stage.summary || '').slice(0, 240),
        durationMs: Number.isFinite(durationMs) && durationMs > 0 && durationMs <= MAX_DEMO_DURATION ? durationMs : 1800,
        actions,
    };
}

function normalizeDemoTracks(tracks, limit = 8) {
    return Array.isArray(tracks)
        ? tracks.filter(track => track && ALLOWED_DEMO_TRACK_KINDS.has(track.kind)).slice(0, limit)
        : [];
}

function normalizeDemo(demo) {
    if (!demo || typeof demo !== 'object') return undefined;
    // Accept 'trace' shorthand (single path-trace track), convert to timeline
    if (demo.type === 'trace') {
        if (!demo.movingObject || !demo.tracedObject || !demo.path) return undefined;
        const durationMs = Math.min(Math.max(Number(demo.durationMs) || 6500, 1200), MAX_DEMO_DURATION);
        const track = {
            kind: 'path-trace',
            movingObject: String(demo.movingObject),
            tracedObject: String(demo.tracedObject),
            path: demo.path,
            samples: Number(demo.frameCount) || Number(demo.samples) || 240,
        };
        return {
            type: 'timeline',
            mode: 'construction',
            autoPlay: false,
            clearBeforePlay: true,
            preserveAfterFinish: true,
            durationMs,
            initialState: normalizeDemoInitialState(demo.initialState),
            stages: [{
                id: 'motion',
                title: '动态观察',
                summary: '观察动点运动和相关对象变化。',
                durationMs,
                actions: [track],
            }],
            tracks: [track],
        };
    }
    if (demo.type !== 'timeline') return undefined;
    const rawDurationMs = Number(demo.durationMs);
    const durationMs = Number.isFinite(rawDurationMs) && rawDurationMs > 0
        ? Math.min(rawDurationMs, MAX_DEMO_DURATION)
        : 8000;
    const tracks = normalizeDemoTracks(demo.tracks, 12);
    const stages = Array.isArray(demo.stages)
        ? demo.stages.map((stage, index) => normalizeDemoStage(stage, index)).filter(Boolean).slice(0, 12)
        : [];
    const normalizedStages = stages.length ? stages : (tracks.length ? [{
        id: 'motion',
        title: '动态观察',
        summary: '观察动点运动和相关对象变化。',
        durationMs,
        actions: tracks,
    }] : []);
    if (!tracks.length && !normalizedStages.length) return undefined;
    return {
        type: 'timeline',
        mode: 'construction',
        autoPlay: false,
        clearBeforePlay: demo.clearBeforePlay !== false,
        preserveAfterFinish: demo.preserveAfterFinish !== false,
        durationMs,
        initialState: normalizeDemoInitialState(demo.initialState),
        stages: normalizedStages,
        tracks: tracks.length ? tracks : normalizedStages.flatMap(stage => stage.actions || []),
    };
}

function normalizeGeoGebraPlanPayload(plan = {}) {
    if (!plan || typeof plan !== 'object') return plan;
    const normalizedPlan = { ...plan };
    const normalizedDemo = normalizeDemo(plan.demo);
    if (normalizedDemo) {
        normalizedPlan.demo = normalizedDemo;
    } else if ('demo' in normalizedPlan) {
        delete normalizedPlan.demo;
    }
    return normalizedPlan;
}

/**
 * Auto-inject ShowLabel(X, true) for key objects that were defined (X = ...)
 * but lack a ShowLabel command. This handles AI truncation where ShowLabel
 * commands at the end of the array are lost due to token limits.
 *
 * Only auto-labels "point-like" names (single uppercase letter or short names
 * like O_circ, P1) to avoid cluttering the canvas with labels on polygons,
 * segments, and helper constructions.
 */
function ensureLabelsForDefinedObjects(commands) {
    // Collect all object names defined via "X = ..." assignments
    const definedObjects = new Set();
    // Pattern: "label = Expression" where label is a valid GeoGebra identifier
    const assignmentPattern = /^([A-Za-z_]\w*)\s*=/;
    for (const cmd of commands) {
        const match = cmd.match(assignmentPattern);
        if (match) {
            definedObjects.add(match[1]);
        }
    }

    // Collect all objects that already have ShowLabel, SetCaption, or SetLabelMode
    const alreadyLabeled = new Set();
    const labelPattern = /^(?:ShowLabel|SetCaption|SetLabelMode)\s*\(\s*([A-Za-z_]\w*)/i;
    for (const cmd of commands) {
        const match = cmd.match(labelPattern);
        if (match) {
            alreadyLabeled.add(match[1]);
        }
    }

    // Determine which defined objects need auto-labeling
    // Only auto-label point-like names: single uppercase letters, or short names
    // that look like geometric points (A, B, C, P, O, M, A1, P1, O_circ, etc.)
    const pointNamePattern = /^[A-Z]([_]?\w{0,6})?$/;
    const injected = [];
    for (const name of definedObjects) {
        if (alreadyLabeled.has(name)) continue;
        if (!pointNamePattern.test(name)) continue;
        // Skip common non-point names (polygons, segments, circles, loci, text, angles)
        if (/^(poly|seg|tri|circ|inc|loc|txt|ang|line|perp|pb|ab|func|eq)/i.test(name)) continue;
        injected.push(`ShowLabel(${name}, true)`);
    }

    if (!injected.length) return commands;
    return [...commands, ...injected];
}

export function parseGeoGebraAgentReply(replyText) {
    const parsedReply = extractJsonObject(replyText);
    const commands = Array.isArray(parsedReply.commands) ? parsedReply.commands : [];
    const safeCommands = commands
        .filter(command => typeof command === 'string')
        .map(command => command.trim())
        .filter(isSafeGeoGebraCommand)
        .slice(0, MAX_COMMANDS);

    // Auto-inject ShowLabel for defined objects that lack one (AI often truncates these)
    const finalCommands = ensureLabelsForDefinedObjects(safeCommands);

    const result = {
        summary: String(parsedReply.summary || 'GeoGebra 动态几何已生成').slice(0, 400),
        perspective: normalizePerspective(parsedReply.perspective),
        commands: finalCommands,
        followUp: String(parsedReply.followUp || '').slice(0, 400),
        repairSummary: parsedReply.repairSummary ? String(parsedReply.repairSummary).slice(0, 400) : undefined,
        studioNotes: parsedReply.studioNotes ? String(parsedReply.studioNotes).slice(0, 400) : undefined,
    };

    const viewport = normalizeViewport(parsedReply.viewport);
    if (viewport) result.viewport = viewport;

    const facts = normalizeFacts(parsedReply.facts);
    if (facts) result.facts = facts;

    const demo = normalizeDemo(parsedReply.demo);
    if (demo) result.demo = demo;

    if (parsedReply.needsClarification) {
        result.needsClarification = true;
    }

    return result;
}

function inferCommandQueries(message) {
    const queries = new Set();
    for (const hint of GEOGEBRA_COMMAND_HINTS) {
        if (hint.pattern.test(message)) {
            hint.query.split(/\s+/).forEach(query => queries.add(query));
        }
    }
    if (queries.size === 0) {
        queries.add('Point');
        queries.add('Line');
        queries.add('Circle');
    }
    return Array.from(queries).slice(0, 8);
}

function buildCommandHints(message) {
    return inferCommandQueries(message).map(query => ({
        query,
        matches: searchGeoGebraCommands(query, 3),
    }));
}

function buildManualHints(message) {
    return inferCommandQueries(message).map(query => ({
        query,
        matches: searchGeoGebraManual(query, 3),
    }));
}

function buildAgentMessages(requestPayload, mode) {
    const commandHints = buildCommandHints(requestPayload.message);
    const manualHints = buildManualHints(requestPayload.message);
    const classification = classifyGeoGebraProblem(requestPayload.message);
    const extractedFacts = extractGeoGebraFacts(requestPayload.message);
    const userPayload = {
        taskType: mode,
        request: requestPayload,
        commandHints,
        manualHints,
        classification,
        extractedFacts,
        outputContract: {
            summary: '中文摘要',
            perspective: 'G 或 T',
            commands: ['GeoGebra English command'],
            followUp: '中文后续建议',
            studioNotes: mode === 'studio_adjust' ? '中文 Studio 调整说明' : undefined,
        },
    };

    return [
        { role: 'system', content: GEOGEBRA_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(userPayload) },
    ];
}

async function callChatCompletion(messages, { env = process.env, fetchImpl = fetch } = {}) {
    const apiBase = String(env.DEEPSEEK_API_BASE || '').replace(/\/$/, '');
    const completionResponse = await fetchImpl(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
            model: env.DEEPSEEK_MODEL || 'deepseek-chat',
            messages,
            temperature: 0.2,
            max_tokens: 4096,
        }),
    });

    const completionPayload = await completionResponse.json().catch(() => ({}));
    if (!completionResponse.ok) {
        const aiError = new Error(completionPayload.error?.message || `GeoGebra Agent HTTP ${completionResponse.status}`);
        aiError.status = completionResponse.status;
        throw aiError;
    }

    const choice = completionPayload.choices?.[0]?.message;
    const content = choice?.content || '';

    // Some reasoning models (e.g. deepseek-v4-flash) put all output in
    // reasoning_content and leave content empty. Extract usable JSON from
    // reasoning_content when content is empty.
    if (!content && choice?.reasoning_content) {
        const reasoning = String(choice.reasoning_content);
        const jsonMatch = reasoning.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            console.warn('[GeoGebra Agent] content empty, extracting JSON from reasoning_content');
            return jsonMatch[0];
        }
    }

    return content;
}

function buildJsonRepairMessages(rawReply, parseError) {
    return [
        {
            role: 'system',
            content: '你是 ICeCream GeoGebra Planner 的 JSON 修复助手。只输出一个符合契约的 JSON 对象。不要输出 Markdown。不要解释。不要使用代码块。',
        },
        {
            role: 'user',
            content: `上一条回复不是合法 JSON，解析错误如下：\n${String(parseError)}\n\n请只输出一个符合 ICeCream GeoGebra Planner 契约的 JSON 对象。\n\n上一条原始回复：\n${String(rawReply).slice(0, 2000)}`,
        },
    ];
}

async function requestGeoGebraCompletion(requestPayload, { mode, env = process.env, fetchImpl = fetch } = {}) {
    if (!hasGeoGebraAiConfig(env)) {
        const configError = new Error('DeepSeek 配置缺失，无法生成 GeoGebra 命令');
        configError.status = 503;
        throw configError;
    }

    const messages = buildAgentMessages(requestPayload, mode);
    let rawReply = await callChatCompletion(messages, { env, fetchImpl });

    // Some reasoning models (e.g. deepseek-v4-flash) intermittently return
    // empty content. Retry up to 2 more times with the same messages.
    for (let retryCount = 0; !rawReply && retryCount < 3; retryCount++) {
        console.warn(`[GeoGebra Agent] Empty AI response, retry ${retryCount + 1}/3...`);
        rawReply = await callChatCompletion(messages, { env, fetchImpl });
    }

    // First attempt: parse the raw reply
    try {
        return parseGeoGebraAgentReply(rawReply);
    } catch (firstParseError) {
        // JSON repair retry: one attempt
        console.warn('[GeoGebra Agent] First JSON parse failed, attempting repair retry:', firstParseError.message);
        console.warn('[GeoGebra Agent] Raw reply (first 500 chars):', String(rawReply).slice(0, 500));
        try {
            const repairMessages = buildJsonRepairMessages(rawReply, firstParseError.message);
            const repairedReply = await callChatCompletion(repairMessages, { env, fetchImpl });
            return parseGeoGebraAgentReply(repairedReply);
        } catch (secondParseError) {
            const readableError = new Error('GeoGebra Agent 没有返回可执行 JSON，请稍后重试或简化题目描述。');
            readableError.status = 502;
            throw readableError;
        }
    }
}

export async function createGeoGebraPlan(body = {}, options = {}) {
    const requestPayload = buildGeoGebraPlanRequest(body);
    const env = options.env || process.env;

    // AI-first: if AI is available, always use the general Planner
    if (hasGeoGebraAiConfig(env)) {
        try {
            const planPayload = await requestGeoGebraCompletion(requestPayload, { ...options, mode: 'plan' });
            // If AI returned commands or explicitly asked for clarification, use AI result
            if (planPayload.commands.length > 0 || planPayload.needsClarification) {
                return {
                    success: true,
                    intent: 'geogebra',
                    data: planPayload,
                };
            }
            // AI returned empty commands without clarification — try deterministic fallback
            console.warn('[GeoGebra Agent] AI returned empty commands, trying deterministic fallback');
            const deterministicFallback = tryCreateDeterministicGeoGebraPlan(requestPayload);
            if (deterministicFallback) {
                return {
                    success: true,
                    intent: 'geogebra',
                    data: normalizeGeoGebraPlanPayload(deterministicFallback),
                };
            }
            // No template match either — return AI result as-is (may have useful summary)
            return {
                success: true,
                intent: 'geogebra',
                data: planPayload,
            };
        } catch (aiError) {
            // AI failed entirely — try deterministic fallback before giving up
            console.warn('[GeoGebra Agent] AI plan failed, trying deterministic fallback:', aiError.message);
            const deterministicFallback = tryCreateDeterministicGeoGebraPlan(requestPayload);
            if (deterministicFallback) {
                return {
                    success: true,
                    intent: 'geogebra',
                    data: normalizeGeoGebraPlanPayload(deterministicFallback),
                };
            }
            throw aiError;
        }
    }

    // Fallback: deterministic template when AI is unavailable
    const deterministicPlan = tryCreateDeterministicGeoGebraPlan(requestPayload);
    if (deterministicPlan) {
        return {
            success: true,
            intent: 'geogebra',
            data: normalizeGeoGebraPlanPayload(deterministicPlan),
        };
    }

    // Neither AI nor template matched
    const fallbackError = new Error('当前没有可用 AI 配置，且未匹配到已知题型模板。请配置 DeepSeek API 或简化题目描述。');
    fallbackError.status = 503;
    throw fallbackError;
}

export async function repairGeoGebraPlan(body = {}, options = {}) {
    const requestPayload = buildGeoGebraRepairRequest(body);
    const repairPayload = await requestGeoGebraCompletion(requestPayload, { ...options, mode: 'repair' });
    return {
        success: true,
        intent: 'geogebra',
        data: {
            ...repairPayload,
            repairSummary: repairPayload.repairSummary || '已根据失败命令生成修复步骤',
        },
    };
}

export async function adjustGeoGebraStudio(body = {}, options = {}) {
    const requestPayload = buildGeoGebraStudioAdjustRequest(body);
    const adjustPayload = await requestGeoGebraCompletion(requestPayload, { ...options, mode: 'studio_adjust' });
    return {
        success: true,
        intent: 'geogebra',
        data: {
            ...adjustPayload,
            studioNotes: adjustPayload.studioNotes || '已根据 GeoGebra Studio 当前画布生成调整命令',
        },
    };
}

export async function createGeoGebraAgentStep(body = {}, options = {}) {
    const requestPayload = buildGeoGebraAgentStepRequest(body);
    const env = options.env || process.env;

    // AI-first: if AI is available, always use the general Planner
    if (hasGeoGebraAiConfig(env)) {
        try {
            const stepPayload = await requestGeoGebraCompletion(requestPayload, { ...options, mode: 'agent_step' });
            // If AI returned commands or explicitly asked for clarification, use AI result
            if (stepPayload.commands.length > 0 || stepPayload.needsClarification) {
                const status = stepPayload.needsClarification ? 'clarify' : 'execute';
                return {
                    success: true,
                    intent: 'geogebra',
                    data: {
                        status,
                        ...stepPayload,
                        manualReferences: searchGeoGebraManual(requestPayload.message, 5),
                        classification: requestPayload.problem.classification,
                    },
                };
            }
            // AI returned empty commands without clarification — try deterministic fallback
            console.warn('[GeoGebra Agent] AI agent-step returned empty commands, trying deterministic fallback');
            const deterministicFallback = tryCreateDeterministicGeoGebraPlan(requestPayload);
            if (deterministicFallback) {
                return {
                    success: true,
                    intent: 'geogebra',
                    data: {
                        status: 'execute',
                        ...normalizeGeoGebraPlanPayload(deterministicFallback),
                    },
                };
            }
            // No template match — return AI result as 'clarify'
            return {
                success: true,
                intent: 'geogebra',
                data: {
                    status: 'clarify',
                    ...stepPayload,
                    manualReferences: searchGeoGebraManual(requestPayload.message, 5),
                    classification: requestPayload.problem.classification,
                },
            };
        } catch (aiError) {
            // AI failed entirely — try deterministic fallback before giving up
            console.warn('[GeoGebra Agent] AI agent-step failed, trying deterministic fallback:', aiError.message);
            const deterministicFallback = tryCreateDeterministicGeoGebraPlan(requestPayload);
            if (deterministicFallback) {
                return {
                    success: true,
                    intent: 'geogebra',
                    data: {
                        status: 'execute',
                        ...normalizeGeoGebraPlanPayload(deterministicFallback),
                    },
                };
            }
            throw aiError;
        }
    }

    // Fallback: deterministic template when AI is unavailable
    const deterministicPlan = tryCreateDeterministicGeoGebraPlan(requestPayload);
    if (deterministicPlan) {
        return {
            success: true,
            intent: 'geogebra',
            data: {
                status: 'execute',
                ...normalizeGeoGebraPlanPayload(deterministicPlan),
            },
        };
    }

    // No AI and no template match
    const manualReferences = searchGeoGebraManual(requestPayload.message, 5);
    return {
        success: true,
        intent: 'geogebra',
        data: {
            status: 'clarify',
            summary: '当前题目信息不足，暂时只进入确认步骤。',
            perspective: requestPayload.preferredPerspective || 'G',
            commands: [],
            followUp: '请补充题目中的关键条件、坐标、半径、长度或目标对象；也可以先修正上传题目的 OCR 文本后再绘图。',
            studioNotes: '当前没有可用 AI 配置，且未匹配到已知题型模板。',
            manualReferences,
            classification: requestPayload.problem.classification,
        },
    };
}
