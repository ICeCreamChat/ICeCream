/**
 * Manim Client Service
 * 处理动画生成请求，调用 Python Manim 服务
 */

import fetch from 'node-fetch';

const MANIM_SERVICE_URL = `http://localhost:${process.env.MANIM_SERVICE_PORT || 8001}`;

const MANIM_SYSTEM_PROMPT = `你是一个 Manim 动画代码生成专家。用户会告诉你想要可视化什么数学概念，你需要生成对应的 Manim 代码。

规则：
1. 只生成 Manim Community 版本兼容的代码
2. 类名必须是 MainScene，继承自 Scene
3. 主方法是 construct(self)
4. 代码要简洁、运行效率高
5. 注释用中文

示例输出格式：
\`\`\`python
from manim import *

class MainScene(Scene):
    def construct(self):
        # 创建正弦函数图像
        axes = Axes(x_range=[-3, 3], y_range=[-2, 2])
        graph = axes.plot(lambda x: np.sin(x), color=BLUE)
        self.play(Create(axes), Create(graph))
        self.wait()
\`\`\``;

/**
 * 处理 Manim 动画生成请求
 */
export async function handleManim(req, res) {
    try {
        const { message, code } = req.body;

        // 如果直接提供了代码，且没有指令，则视为纯渲染
        if (code && !message) {
            return renderCode(req, res);
        }

        if (!message) {
            return res.status(400).json({
                success: false,
                error: '请描述您想要的动画效果'
            });
        }

        // 1. 使用 DeepSeek 生成 Manim 代码
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

        let promptContent = message;
        if (code) {
            promptContent = `用户指令: ${message}\n\n当前代码 (请基于此修改):\n\`\`\`python\n${code}\n\`\`\``;
        }

        const codeResponse = await fetch(`${process.env.DEEPSEEK_API_BASE}/chat/completions`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
                messages: [
                    { role: 'system', content: MANIM_SYSTEM_PROMPT },
                    { role: 'user', content: promptContent }
                ],
                temperature: 0.3,
                max_tokens: 2048
            })
        }).finally(() => clearTimeout(timeoutId));

        if (!codeResponse.ok) {
            throw new Error('代码生成失败');
        }

        const codeData = await codeResponse.json();
        const generatedContent = codeData.choices?.[0]?.message?.content || '';

        // 提取代码块
        const codeMatch = generatedContent.match(/```python\n([\s\S]*?)```/);
        const extractedCode = codeMatch ? codeMatch[1].trim() : generatedContent;

        // 2. 调用 Manim 服务渲染
        console.log('[Manim Client] Calling render service:', MANIM_SERVICE_URL);
        console.log('[Manim Client] Code length:', extractedCode.length);

        const renderResponse = await fetch(`${MANIM_SERVICE_URL}/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: extractedCode })
        });

        console.log('[Manim Client] Render response status:', renderResponse.status);

        if (!renderResponse.ok) {
            const errorData = await renderResponse.json().catch(() => ({}));
            console.log('[Manim Client] Render failed:', errorData);
            // Return code even if render failed, so user can edit it
            return res.json({
                success: true,
                intent: 'manim',
                code: extractedCode,
                rendered: false,
                warning: errorData.error || 'Manim 服务渲染超时，已为您载入代码'
            });
        }

        const renderData = await renderResponse.json();
        console.log('[Manim Client] Render success:', {
            hasVideoUrl: !!renderData.videoUrl,
            hasBase64: !!renderData.videoBase64
        });

        return res.json({
            success: true,
            intent: 'manim',
            code: extractedCode,
            rendered: true,
            videoUrl: renderData.videoUrl, // Flattened
            videoBase64: renderData.videoBase64
        });

    } catch (error) {
        console.error('[Manim Client] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
}

/**
 * 直接渲染 Manim 代码
 */
export async function renderCode(req, res) {
    try {
        const { code } = req.body;

        if (!code) {
            return res.status(400).json({
                success: false,
                error: '代码不能为空'
            });
        }

        const response = await fetch(`${MANIM_SERVICE_URL}/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
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
            videoBase64: data.videoBase64
        });

    } catch (error) {
        console.error('[Manim Client] Render Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
}

/**
 * 获取 Manim 服务状态
 */
export async function getStatus(req, res) {
    try {
        const response = await fetch(`${MANIM_SERVICE_URL}/health`, {
            method: 'GET',
            timeout: 3000
        });

        const available = response.ok;

        return res.json({
            success: true,
            data: {
                available: available,
                url: MANIM_SERVICE_URL
            }
        });

    } catch (error) {
        return res.json({
            success: true,
            data: {
                available: false,
                error: error.message
            }
        });
    }
}

export default { handleManim, renderCode, getStatus };
