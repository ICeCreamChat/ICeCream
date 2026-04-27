/**
 * Intent Router Middleware
 * 根据意图分类结果路由到对应服务
 */

import { classifyIntent } from '../services/intent-classifier.js';

// 置信度阈值
const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;

export function getConfidenceThreshold(env = process.env) {
    const parsed = Number.parseFloat(env.INTENT_CONFIDENCE_THRESHOLD);
    return Number.isFinite(parsed) ? parsed : DEFAULT_CONFIDENCE_THRESHOLD;
}

/**
 * 意图路由中间件
 */
export async function intentRouter(req, res, next) {
    try {
        const { message, mode } = req.body;
        const hasImage = !!req.file;

        // 1. 检查是否有显式模态切换
        if (mode && ['chat', 'manim', 'solver'].includes(mode)) {
            console.log(`[Intent Router] Explicit mode: ${mode}`);
            return routeToService(req, res, mode);
        }

        // 2. 进行意图分类
        const classification = await classifyIntent(message || '', hasImage);
        console.log(`[Intent Router] Classification:`, classification);

        // 3. 根据置信度决策
        if (classification.confidence >= getConfidenceThreshold()) {
            // 高置信度：直接路由
            return routeToService(req, res, classification.intent);
        } else {
            // 低置信度：返回确认请求
            return res.json({
                success: true,
                needConfirmation: true,
                classification: classification,
                message: '我不太确定您想做什么，请选择：',
                options: [
                    { intent: 'chat', label: '💬 聊一聊', description: '普通对话' },
                    { intent: 'manim', label: '🎬 生成动画', description: '数学可视化' },
                    { intent: 'solver', label: '📐 解这道题', description: '智能解题' }
                ]
            });
        }

    } catch (error) {
        console.error('[Intent Router] Error:', error);
        next(error);
    }
}

/**
 * 路由到对应服务
 */
async function routeToService(req, res, intent) {
    const { message } = req.body;
    const imageFile = req.file;

    try {
        switch (intent) {
            case 'chat':
                // 调用聊天服务
                const chatHandler = await import('../../services/chat/chat-handler.js');
                return chatHandler.handleChat(req, res);

            case 'manim':
                // 调用 Manim 服务
                const manimClient = await import('../../services/manim/manim-client.js');
                return manimClient.handleManim(req, res);

            case 'solver':
                // 调用解题服务
                const solverService = await import('../../services/solver/solver-handler.js');
                return solverService.handleSolve(req, res);

            default:
                // 默认聊天
                const defaultHandler = await import('../../services/chat/chat-handler.js');
                return defaultHandler.handleChat(req, res);
        }
    } catch (error) {
        console.error(`[Intent Router] Service error (${intent}):`, error);
        res.status(500).json({
            success: false,
            error: `服务调用失败: ${error.message}`
        });
    }
}

export default { intentRouter };
