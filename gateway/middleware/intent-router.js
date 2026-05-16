/**
 * Intent Router Middleware
 * Route requests to downstream services based on classified intent.
 */

import { classifyIntent } from '../services/intent-classifier.js';

const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;

export function getConfidenceThreshold(env = process.env) {
    const parsed = Number.parseFloat(env.INTENT_CONFIDENCE_THRESHOLD);
    return Number.isFinite(parsed) ? parsed : DEFAULT_CONFIDENCE_THRESHOLD;
}

/**
 * Intent routing middleware
 */
export async function intentRouter(req, res, next) {
    try {
        const { message, mode } = req.body;
        const originalMessage = typeof message === 'string' ? message : '';
        const hasImage = !!req.file;

        if (mode && ['chat', 'manim', 'solver'].includes(mode)) {
            console.log(`[Intent Router] Explicit mode: ${mode}`);
            return routeToService(req, res, mode);
        }

        const classification = await classifyIntent(message || '', hasImage);
        console.log('[Intent Router] Classification:', classification);

        if (classification.confidence >= getConfidenceThreshold()) {
            return routeToService(req, res, classification.intent);
        }

        return res.json({
            success: true,
            needConfirmation: true,
            classification,
            originalMessage,
            message: '我不太确定您想做什么，请选择：',
            options: [
                { intent: 'chat', label: '💬 聊一聊', description: '普通对话' },
                { intent: 'manim', label: '🎞 生成动画', description: '数学可视化' },
                { intent: 'solver', label: '🧻 解这道题', description: '智能解题' }
            ]
        });
    } catch (error) {
        console.error('[Intent Router] Error:', error);
        next(error);
    }
}

/**
 * Route to target service
 */
async function routeToService(req, res, intent) {
    try {
        switch (intent) {
            case 'chat': {
                const chatHandler = await import('../../services/chat/chat-handler.js');
                return chatHandler.handleChat(req, res);
            }
            case 'manim': {
                const manimClient = await import('../../services/manim/manim-client.js');
                return manimClient.handleManim(req, res);
            }
            case 'solver': {
                const solverService = await import('../../services/solver/solver-handler.js');
                return solverService.handleSolve(req, res);
            }
            default: {
                const defaultHandler = await import('../../services/chat/chat-handler.js');
                return defaultHandler.handleChat(req, res);
            }
        }
    } catch (error) {
        console.error(`[Intent Router] Service error (${intent}):`, error);
        res.status(500).json({
            success: false,
            error: '服务暂时不可用，请稍后重试'
        });
    }
}

export default { intentRouter };
