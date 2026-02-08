/**
 * Chat Handler Service
 * 处理普通对话请求，调用 DeepSeek API
 */

import fetch from 'node-fetch';

const SYSTEM_PROMPT = `你是 ICeCream，一个友好、智能的 AI 助手。你擅长：
1. 日常对话和问答
2. 知识咨询和解释
3. 代码帮助和技术讨论
4. 数学和科学问题

请用中文回复，保持友好和专业。如果用户想要生成动画或解题，建议他们使用对应的模式。`;

/**
 * 处理聊天请求
 */
export async function handleChat(req, res) {
    try {
        const { message, messages = [], context } = req.body;

        if (!message && messages.length === 0) {
            return res.status(400).json({
                success: false,
                error: '消息不能为空'
            });
        }

        // 输入验证：限制消息长度
        const maxMessageLength = 10000;
        if (message && message.length > maxMessageLength) {
            return res.status(400).json({
                success: false,
                error: `消息过长，请限制在 ${maxMessageLength} 字符以内`
            });
        }

        // 构建消息列表
        const chatMessages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...messages,
        ];

        if (message) {
            chatMessages.push({ role: 'user', content: message });
        }

        // 创建超时控制器
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30秒超时

        try {
            // 调用 DeepSeek API
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
                    reply: reply,
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
 * 处理流式聊天请求
 */
export async function handleChatStream(req, res) {
    try {
        const { message, messages = [] } = req.body;

        // 设置 SSE 响应头
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const chatMessages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...messages,
        ];

        if (message) {
            chatMessages.push({ role: 'user', content: message });
        }

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
            })
        });

        if (!response.ok) {
            res.write(`data: ${JSON.stringify({ error: 'API Error' })}\n\n`);
            res.end();
            return;
        }

        // 流式转发
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            res.write(chunk);
        }

        res.write('data: [DONE]\n\n');
        res.end();

    } catch (error) {
        console.error('[Chat Handler] Stream Error:', error);
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        res.end();
    }
}

export default { handleChat, handleChatStream };
