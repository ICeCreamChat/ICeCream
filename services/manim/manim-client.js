/**
 * Manim Client Service
 * Bridges the Node gateway to the Python Manim service.
 */

import fetch from 'node-fetch';
import { normalizeClientId, validateManimCode } from '../../gateway/security.js';

export function getManimServiceUrl() {
    return process.env.MANIM_SERVICE_URL || `http://localhost:${process.env.MANIM_SERVICE_PORT || 8001}`;
}

const MANIM_SYSTEM_PROMPT = `You are a Manim Community code generator.
Return one complete Python file only.
Rules:
1. Use Manim Community APIs.
2. The scene class must be MainScene(Scene).
3. The scene must implement construct(self).
4. Use Text for Chinese text and MathTex only for formulas.
5. Keep code concise and safe. Do not use filesystem, network, subprocess, eval, exec, or dynamic imports.`;

const MANIM_INTENT_KEYWORDS = [
    'manim',
    '动画',
    '可视化',
    '演示',
    '展示',
    '函数',
    '公式',
    '图像',
    '坐标',
    '几何',
    '圆',
    '三角形',
    '柱状图',
    '折线图',
    '流程',
    '牛顿',
    '运动',
    '速度',
    '加速度',
];

function getManimHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.MANIM_SERVICE_TOKEN) {
        headers['X-Manim-Service-Token'] = process.env.MANIM_SERVICE_TOKEN;
    }
    return headers;
}

function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(ms);
    }

    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
}

function extractGeneratedCode(content = '') {
    const codeMatch = String(content).match(/```(?:python)?\r?\n([\s\S]*?)```/i);
    return (codeMatch ? codeMatch[1] : content).trim();
}

function normalizeAgentMode(body = {}) {
    const requestedMode = String(body.mode || '').toLowerCase();
    if (['create', 'modify', 'render'].includes(requestedMode)) {
        return requestedMode;
    }
    if (body.type === 'modification' || body.currentCode || body.code) {
        return 'modify';
    }
    return 'create';
}

function hasDeepSeekConfig(env = process.env) {
    return Boolean(env.DEEPSEEK_API_BASE && env.DEEPSEEK_API_KEY);
}

function buildAgentUnavailableResponse(reason) {
    const detail = reason ? String(reason) : 'Agent unavailable';
    return {
        success: true,
        intent: 'manim',
        rendered: false,
        code: '',
        warning: `Manim Agent 暂时不可用：${detail}`,
        agentTrace: {
            skills: [],
            retries: 0,
            failureReason: detail,
        },
    };
}

function normalizeAgentResult(data = {}) {
    return {
        success: data.success !== false,
        intent: 'manim',
        rendered: Boolean(data.rendered),
        code: data.code || '',
        videoUrl: data.videoUrl,
        videoBase64: data.videoBase64,
        warning: data.warning,
        clarification: data.clarification,
        agentTrace: data.agentTrace,
    };
}

export function isManimAgentEnabled(env = process.env) {
    const value = String(env.MANIM_AGENT_ENABLED ?? 'true').trim().toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(value);
}

export function buildAgentPayload(body = {}) {
    return {
        message: String(body.message || ''),
        mode: normalizeAgentMode(body),
        currentCode: String(body.currentCode ?? body.code ?? ''),
        clientId: normalizeClientId(body.clientId || body.client_id, 'gateway'),
    };
}

export function buildRenderPayload(body = {}) {
    return {
        code: body.code,
        client_id: normalizeClientId(body.client_id),
    };
}

export function buildSuggestionsPayload(body = {}) {
    const count = Number(body.count);
    return {
        code: String(body.code || ''),
        count: Number.isInteger(count) ? Math.min(Math.max(count, 1), 8) : 5,
    };
}

async function runAgent(payload) {
    const response = await fetch(`${getManimServiceUrl()}/agent/run`, {
        method: 'POST',
        headers: getManimHeaders(),
        body: JSON.stringify(payload),
        signal: timeoutSignal(180000),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || `Manim Agent HTTP ${response.status}`);
    }

    return normalizeAgentResult(data);
}

/**
 * Legacy direct DeepSeek generation path. Used when MANIM_AGENT_ENABLED=false.
 */
async function handleManimLegacy(req, res) {
    const { message, code } = req.body;

    if (!message) {
        return res.status(400).json({
            success: false,
            error: '请描述您想要的动画效果',
        });
    }

    if (!hasDeepSeekConfig()) {
        return res.status(500).json({
            success: false,
            error: 'DeepSeek 配置缺失，无法使用旧版 Manim 生成路径',
        });
    }

    let promptContent = message;
    if (code) {
        promptContent = `用户指令: ${message}\n\n当前代码，请基于此修改:\n\`\`\`python\n${code}\n\`\`\``;
    }

    const codeResponse = await fetch(`${process.env.DEEPSEEK_API_BASE}/chat/completions`, {
        method: 'POST',
        signal: timeoutSignal(60000),
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
            model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
            messages: [
                { role: 'system', content: MANIM_SYSTEM_PROMPT },
                { role: 'user', content: promptContent },
            ],
            temperature: 0.3,
            max_tokens: 2048,
        }),
    });

    if (!codeResponse.ok) {
        throw new Error('代码生成失败');
    }

    const codeData = await codeResponse.json();
    const generatedContent = codeData.choices?.[0]?.message?.content || '';
    const extractedCode = extractGeneratedCode(generatedContent);
    const validation = validateManimCode(extractedCode);
    if (!validation.valid) {
        throw new Error(validation.reason);
    }

    const renderResponse = await fetch(`${getManimServiceUrl()}/render`, {
        method: 'POST',
        headers: getManimHeaders(),
        body: JSON.stringify({
            code: extractedCode,
            client_id: normalizeClientId(req.body.client_id),
        }),
        signal: timeoutSignal(180000),
    });

    if (!renderResponse.ok) {
        const errorData = await renderResponse.json().catch(() => ({}));
        return res.json({
            success: true,
            intent: 'manim',
            code: extractedCode,
            rendered: false,
            warning: errorData.error || 'Manim 服务渲染失败，已为您载入代码',
        });
    }

    const renderData = await renderResponse.json();
    return res.json({
        success: true,
        intent: 'manim',
        code: extractedCode,
        rendered: true,
        videoUrl: renderData.videoUrl,
        videoBase64: renderData.videoBase64,
    });
}

/**
 * Handle Manim animation generation requests.
 */
export async function handleManim(req, res) {
    try {
        const { message, code } = req.body;

        if (code && !message) {
            return renderCode(req, res);
        }

        if (!message) {
            return res.status(400).json({
                success: false,
                error: '请描述您想要的动画效果',
            });
        }

        if (!isManimAgentEnabled()) {
            return handleManimLegacy(req, res);
        }

        try {
            const payload = buildAgentPayload(req.body);
            const data = await runAgent(payload);
            return res.json(data);
        } catch (agentError) {
            console.error('[Manim Client] Agent Error:', agentError);
            return res.json(buildAgentUnavailableResponse(agentError.message));
        }
    } catch (error) {
        console.error('[Manim Client] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message,
        });
    }
}

/**
 * Proxy the Manim Agent event stream as NDJSON.
 */
export async function streamAgent(req, res) {
    try {
        const payload = buildAgentPayload(req.body);
        const response = await fetch(`${getManimServiceUrl()}/agent/stream`, {
            method: 'POST',
            headers: getManimHeaders(),
            body: JSON.stringify(payload),
            signal: timeoutSignal(180000),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            return res.status(response.status).json({
                success: false,
                error: errorData.error || `Manim Agent HTTP ${response.status}`,
            });
        }

        res.status(200);
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');

        for await (const chunk of response.body) {
            res.write(chunk);
        }
        return res.end();
    } catch (error) {
        console.error('[Manim Client] Agent Stream Error:', error);
        if (!res.headersSent) {
            return res.status(500).json({ success: false, error: error.message });
        }
        res.write(JSON.stringify({ type: 'error', success: false, error: error.message }) + '\n');
        return res.end();
    }
}

/**
 * Lightweight local intent classification for auto mode.
 */
export async function classifyManimIntent(req, res) {
    const message = String(req.body?.message || '').trim();
    const lower = message.toLowerCase();
    const matched = MANIM_INTENT_KEYWORDS.some(keyword => lower.includes(keyword.toLowerCase()));
    const vague = /^(做个动画|画个动画|生成动画|随便.*动画)$/.test(message);
    const confidence = matched ? (vague ? 0.45 : 0.82) : 0.2;

    return res.json({
        success: true,
        intent: matched ? 'manim' : 'chat',
        confidence,
        clarification: matched && confidence < 0.6
            ? {
                question: '你想让这个动画重点展示什么？',
                options: ['分步骤讲解', '对比变化过程', '简洁概念示意'],
                originalMessage: message,
            }
            : null,
    });
}

/**
 * Directly render Manim code.
 */
export async function renderCode(req, res) {
    try {
        const { code } = req.body;

        if (!code) {
            return res.status(400).json({
                success: false,
                error: '代码不能为空',
            });
        }

        const validation = validateManimCode(code);
        if (!validation.valid) {
            return res.status(400).json({
                success: false,
                error: validation.reason,
            });
        }

        const payload = buildRenderPayload(req.body);
        const response = await fetch(`${getManimServiceUrl()}/render`, {
            method: 'POST',
            headers: getManimHeaders(),
            body: JSON.stringify(payload),
            signal: timeoutSignal(180000),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || 'Manim 渲染失败');
        }

        const data = await response.json();
        return res.json({
            success: true,
            rendered: true,
            videoUrl: data.videoUrl,
            videoBase64: data.videoBase64,
        });
    } catch (error) {
        console.error('[Manim Client] Render Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message,
        });
    }
}

/**
 * Get AI modification suggestions from the Manim service.
 */
export async function getSuggestions(req, res) {
    try {
        const payload = buildSuggestionsPayload(req.body);
        if (!payload.code.trim()) {
            return res.status(400).json({
                success: false,
                error: '代码不能为空',
            });
        }

        const response = await fetch(`${getManimServiceUrl()}/api/suggestions`, {
            method: 'POST',
            headers: getManimHeaders(),
            body: JSON.stringify(payload),
            signal: timeoutSignal(15000),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || 'Manim 建议生成失败');
        }

        const data = await response.json();
        const rawSuggestions = Array.isArray(data.suggestions)
            ? data.suggestions
            : Array.isArray(data.data?.suggestions)
                ? data.data.suggestions
                : [];
        const suggestions = rawSuggestions.map(item => String(item).trim()).filter(Boolean);

        return res.json({
            success: true,
            data: { suggestions },
        });
    } catch (error) {
        console.error('[Manim Client] Suggestions Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message,
        });
    }
}

/**
 * Get Manim service status.
 */
export async function getStatus(req, res) {
    try {
        const response = await fetch(`${getManimServiceUrl()}/health`, {
            method: 'GET',
            signal: timeoutSignal(3000),
        });

        return res.json({
            success: true,
            data: {
                available: response.ok,
                url: getManimServiceUrl(),
            },
        });
    } catch (error) {
        return res.json({
            success: true,
            data: {
                available: false,
                error: error.message,
            },
        });
    }
}

export default {
    handleManim,
    streamAgent,
    classifyManimIntent,
    renderCode,
    getSuggestions,
    getStatus,
};
