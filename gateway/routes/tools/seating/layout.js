import express from 'express';
import fetch from 'node-fetch';
import {
    buildSeatingPlanResponse,
    normalizePlanRequest,
} from '../../../services/seating-layout.js';

const router = express.Router();

/**
 * POST /api/tools/seating/plan
 * 生成座位表 (含一致性校验)
 */
/**
 * POST /api/tools/seating/plan
 * AI Custom Layout Generator (Role 2)
 * Generates grid structure (seats/aisles) from natural language description
 */
router.post('/plan', async (req, res) => {
    try {
        const planRequest = normalizePlanRequest(req.body);
        const { prompt, rows, cols, groupSize, guardiansEnabled } = planRequest;

        if (!prompt) {
            const data = buildSeatingPlanResponse({
                ...planRequest,
                reasoning: '已应用预设教室布局'
            });
            return res.json({ success: true, data });
        }

        const systemPrompt = `你是教室布局专家。用户希望在一个 ${rows}行 × ${cols}列 的网格中设计特殊的座位布局。

【任务】根据用户描述，生成布局矩阵。
- 标记为 1 的位置是座位
- 标记为 0 的位置是过道/空地

【常用布局参考】
- "U型": 只有三边有座位，中间空
- "小组": 4-6人一组，组间有过道
- "圆桌": (近似)- "两侧": 中间大过道
- "三人一组/两人一组": 每组座位连续，中间不要跨过道
- "护法": 由 guardiansEnabled 表示，不要放入矩阵

【输出格式 (Strict JSON)】
{
  "matrix": [
    [1, 1, 0, 0, 1, 1],
    [1, 1, 0, 0, 1, 1]
  ],
  "reasoning": "设计的简短说明"
}`;

        const response = await fetch(`${process.env.DEEPSEEK_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.DEEPSEEK_CHAT_MODEL || 'deepseek-chat',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.2,
                response_format: { type: "json_object" }
            }),
            signal: AbortSignal.timeout(60000)
        });

        if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            throw new Error(errBody.error?.message || `AI API 返回 ${response.status}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error('AI 无响应');

        let result;
        try {
            result = JSON.parse(content);
        } catch {
            throw new Error('AI 返回格式错误');
        }

        res.json({
            success: true,
            data: buildSeatingPlanResponse({
                rows,
                cols,
                matrix: result.matrix,
                reasoning: result.reasoning || 'AI 教室布局',
                groupSize,
                guardiansEnabled
            })
        });

    } catch (error) {
        console.error('[Seating/Plan] Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
