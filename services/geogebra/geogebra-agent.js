import fetch from 'node-fetch';

import { searchGeoGebraCommands } from './command-search.js';
import { GEOGEBRA_SYSTEM_PROMPT } from './geogebra-prompt.js';

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

function isSafeGeoGebraCommand(command) {
    const trimmedCommand = String(command || '').trim();
    if (!trimmedCommand || trimmedCommand.length > MAX_COMMAND_LENGTH) return false;
    return !/(RunClickScript|RunUpdateScript|SetGlobalJavaScript|javascript:|ggbApplet|document\.|window\.|fetch\(|XMLHttpRequest|<script|eval\(|Function\(|localStorage|sessionStorage|cookie)/i.test(trimmedCommand);
}

function extractJsonObject(text) {
    const normalizedText = String(text || '').replace(/```json|```/gi, '').trim();
    const jsonMatch = normalizedText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        throw new Error('GeoGebra Agent 没有返回 JSON');
    }
    return JSON.parse(jsonMatch[0]);
}

export function parseGeoGebraAgentReply(replyText) {
    const parsedReply = extractJsonObject(replyText);
    const commands = Array.isArray(parsedReply.commands) ? parsedReply.commands : [];
    const safeCommands = commands
        .filter(command => typeof command === 'string')
        .map(command => command.trim())
        .filter(isSafeGeoGebraCommand)
        .slice(0, MAX_COMMANDS);

    return {
        summary: String(parsedReply.summary || 'GeoGebra 动态几何已生成').slice(0, 400),
        perspective: normalizePerspective(parsedReply.perspective),
        commands: safeCommands,
        followUp: String(parsedReply.followUp || '').slice(0, 400),
        repairSummary: parsedReply.repairSummary ? String(parsedReply.repairSummary).slice(0, 400) : undefined,
    };
}

function inferCommandQueries(message) {
    const queries = new Set();
    for (const hint of CHINESE_COMMAND_HINTS) {
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

function buildAgentMessages(requestPayload, mode) {
    const commandHints = buildCommandHints(requestPayload.message);
    const userPayload = {
        taskType: mode,
        request: requestPayload,
        commandHints,
        outputContract: {
            summary: '中文摘要',
            perspective: 'G 或 T',
            commands: ['GeoGebra English command'],
            followUp: '中文后续建议',
        },
    };

    return [
        { role: 'system', content: GEOGEBRA_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(userPayload) },
    ];
}

async function requestGeoGebraCompletion(requestPayload, { mode, env = process.env, fetchImpl = fetch } = {}) {
    if (!hasGeoGebraAiConfig(env)) {
        const configError = new Error('DeepSeek 配置缺失，无法生成 GeoGebra 命令');
        configError.status = 503;
        throw configError;
    }

    const apiBase = String(env.DEEPSEEK_API_BASE || '').replace(/\/$/, '');
    const completionResponse = await fetchImpl(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
            model: env.DEEPSEEK_MODEL || 'deepseek-chat',
            messages: buildAgentMessages(requestPayload, mode),
            temperature: 0.2,
            max_tokens: 1600,
        }),
    });

    const completionPayload = await completionResponse.json().catch(() => ({}));
    if (!completionResponse.ok) {
        const aiError = new Error(completionPayload.error?.message || `GeoGebra Agent HTTP ${completionResponse.status}`);
        aiError.status = completionResponse.status;
        throw aiError;
    }

    const replyText = completionPayload.choices?.[0]?.message?.content || '';
    return parseGeoGebraAgentReply(replyText);
}

export async function createGeoGebraPlan(body = {}, options = {}) {
    const requestPayload = buildGeoGebraPlanRequest(body);
    const planPayload = await requestGeoGebraCompletion(requestPayload, { ...options, mode: 'plan' });
    return {
        success: true,
        intent: 'geogebra',
        data: planPayload,
    };
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
