/**
 * Chat Handler Service
 * Handles chat and streaming chat requests via DeepSeek API.
 */

import fetch from 'node-fetch';

const SYSTEM_PROMPT = `你是 ICeCream，一个友好、智能的 AI 助手。你擅长：
1. 日常对话和问答
2. 知识咨询和解释
3. 代码帮助和技术讨论
4. 数学和科学问题
请用中文回复，保持友好和专业。如果用户想要生成动画或解题，建议他们使用对应的模式。`;

const MAX_MESSAGE_LENGTH = 10000;
const MAX_HISTORY_MESSAGES = 20;

function normalizeMessages(messages) {
    const source = Array.isArray(messages) ? messages : [];
    return source
        .filter(item => item && (item.role === 'user' || item.role === 'assistant'))
        .map(item => ({
            role: item.role,
            content: typeof item.content === 'string' ? item.content : String(item.content || ''),
        }))
        .slice(-MAX_HISTORY_MESSAGES);
}

/**
 * Handle regular chat request
 */
export async function handleChat(req, res) {
    try {
        const { message, messages = [] } = req.body;
        const safeMessages = normalizeMessages(messages);
        const normalizedMessage = typeof message === 'string' ? message : String(message || '');

        if (!normalizedMessage && (!messages || messages.length === 0)) {
            return res.status(400).json({
                success: false,
                error: '消息不能为空'
            });
        }

        if (normalizedMessage && normalizedMessage.length > MAX_MESSAGE_LENGTH) {
            return res.status(400).json({
                success: false,
                error: `消息过长，请限制在 ${MAX_MESSAGE_LENGTH} 字符以内`
            });
        }

        const chatMessages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...safeMessages,
        ];

        if (normalizedMessage) {
            chatMessages.push({ role: 'user', content: normalizedMessage });
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        try {
            const response = await fetch(`${process.env.DEEPSEEK_API_BASE}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
                },
                body: JSON.stringify({
                    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
                    messages: chatMessages,
                    temperature: 0.7,
                    max_tokens: 2048
                }),
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error?.message || `API Error: ${response.status}`);
            }

            const data = await response.json();
            const reply = data.choices?.[0]?.message?.content || '';

            return res.json({
                success: true,
                intent: 'chat',
                data: {
                    reply,
                    usage: data.usage
                }
            });
        } catch (fetchError) {
            clearTimeout(timeout);
            if (fetchError.name === 'AbortError') {
                throw new Error('请求超时，请稍后重试');
            }
            throw fetchError;
        }

    } catch (error) {
        console.error('[Chat Handler] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
}

/**
 * Handle streaming chat request
 */
export async function handleChatStream(req, res) {
    let timeout = null;
    let controller = null;
    let clientClosed = false;

    const onClose = () => {
        clientClosed = true;
        controller?.abort();
    };

    try {
        const { message, messages = [] } = req.body;
        const safeMessages = normalizeMessages(messages);
        const normalizedMessage = typeof message === 'string' ? message : String(message || '');

        if (normalizedMessage && normalizedMessage.length > MAX_MESSAGE_LENGTH) {
            return res.status(400).json({
                success: false,
                error: `消息过长，请限制在 ${MAX_MESSAGE_LENGTH} 字符以内`
            });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const chatMessages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...safeMessages,
        ];

        if (normalizedMessage) {
            chatMessages.push({ role: 'user', content: normalizedMessage });
        }

        controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 60000);
        req.on('close', onClose);

        const response = await fetch(`${process.env.DEEPSEEK_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
                messages: chatMessages,
                temperature: 0.7,
                max_tokens: 2048,
                stream: true
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);
        timeout = null;

        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({}));
            res.write(`data: ${JSON.stringify({ error: errorBody.error?.message || 'API Error' })}\n\n`);
            res.end();
            return;
        }

        if (!response.body) {
            res.write(`data: ${JSON.stringify({ error: 'Empty stream body' })}\n\n`);
            res.end();
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            if (clientClosed) break;

            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            res.write(chunk);
        }

        if (!clientClosed && !res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
        }
    } catch (error) {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }

        if (error.name === 'AbortError' && clientClosed) {
            return;
        }

        if (error.name === 'AbortError') {
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ error: '请求超时，请稍后重试' })}\n\n`);
                res.end();
            }
            return;
        }

        console.error('[Chat Handler] Stream Error:', error);
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        }
    } finally {
        if (timeout) clearTimeout(timeout);
        req.off('close', onClose);
    }
}

export default { handleChat, handleChatStream };
