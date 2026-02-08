/**
 * Intent Classifier Service
 * 使用 DeepSeek API 进行意图分类
 */

import fetch from 'node-fetch';

const INTENT_PROMPT = `
你是一个意图分类器。请根据用户消息判断其最可能的意图。

## 意图类型
1. **chat**: 普通闲聊、问答、知识咨询、日常对话
2. **manim**: 想生成数学动画、可视化图形、Manim 代码
3. **solver**: 想解题、求解数学问题、上传了题目图片

## 判断规则
- 包含"画"、"动画"、"可视化"、"演示"、"Manim"、"视频" → 大概率 manim
- 包含"解题"、"求解"、"证明"、"计算"、"答案"、"怎么做" → 大概率 solver
- 上传了图片 → 大概率 solver（除非明确说要做动画）
- 问候语、闲聊、知识问答 → chat
- 其他不明确的 → chat

## 输出格式
只返回一个 JSON，不要有其他内容：
{"intent": "chat|manim|solver", "confidence": 0.0~1.0}

---

用户消息："{USER_MESSAGE}"
是否上传图片：{HAS_IMAGE}
`.trim();

/**
 * 使用 DeepSeek API 分类用户意图
 * @param {string} message - 用户消息
 * @param {boolean} hasImage - 是否上传了图片
 * @returns {Promise<{intent: string, confidence: number}>}
 */
export async function classifyIntent(message, hasImage = false) {
    // 如果意图分类器被禁用，返回默认 chat
    if (process.env.INTENT_CLASSIFIER_ENABLED !== 'true') {
        return { intent: 'chat', confidence: 1.0, source: 'disabled' };
    }

    // 快速关键词匹配（优先级高于 AI）
    const quickResult = quickKeywordMatch(message, hasImage);
    if (quickResult.confidence >= 0.9) {
        return { ...quickResult, source: 'keyword' };
    }

    // 如果有图片且没有明确的动画相关词汇，直接返回 solver
    if (hasImage) {
        const manimKeywords = ['动画', '可视化', 'manim', '视频', '演示'];
        const hasManimIntent = manimKeywords.some(kw => message.toLowerCase().includes(kw));
        if (!hasManimIntent) {
            return { intent: 'solver', confidence: 0.95, source: 'image_detection' };
        }
    }

    // 调用 DeepSeek API 进行意图分类
    try {
        const prompt = INTENT_PROMPT
            .replace('{USER_MESSAGE}', message)
            .replace('{HAS_IMAGE}', hasImage ? '是' : '否');

        const response = await fetch(`${process.env.DEEPSEEK_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
                messages: [
                    { role: 'user', content: prompt }
                ],
                temperature: 0,
                max_tokens: 50
            })
        });

        if (!response.ok) {
            console.error('[Intent Classifier] API Error:', response.status);
            return { intent: 'chat', confidence: 0.5, source: 'api_error' };
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content?.trim();

        // 解析 JSON 响应
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            return {
                intent: result.intent || 'chat',
                confidence: Math.min(1, Math.max(0, result.confidence || 0.5)),
                source: 'ai'
            };
        }

        return { intent: 'chat', confidence: 0.5, source: 'parse_error' };

    } catch (error) {
        console.error('[Intent Classifier] Error:', error.message);
        return { intent: 'chat', confidence: 0.5, source: 'exception' };
    }
}

/**
 * 快速关键词匹配
 */
function quickKeywordMatch(message, hasImage) {
    const lowerMessage = message.toLowerCase();

    // Manim / 动画相关
    const manimKeywords = ['画一个', '画个', '动画', '可视化', 'manim', '演示', '视频展示', '图形'];
    for (const kw of manimKeywords) {
        if (lowerMessage.includes(kw)) {
            return { intent: 'manim', confidence: 0.95 };
        }
    }

    // Solver / 解题相关
    const solverKeywords = ['解题', '求解', '证明', '计算', '答案', '怎么做', '怎么算', '这道题'];
    for (const kw of solverKeywords) {
        if (lowerMessage.includes(kw)) {
            return { intent: 'solver', confidence: 0.9 };
        }
    }

    // 有图片默认解题
    if (hasImage) {
        return { intent: 'solver', confidence: 0.85 };
    }

    // 默认聊天
    return { intent: 'chat', confidence: 0.6 };
}

export default { classifyIntent };
