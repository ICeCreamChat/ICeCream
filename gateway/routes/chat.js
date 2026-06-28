/**
 * Chat Routes - 直接访问聊天服务的路由
 */

import express from 'express';
import { sendHttpError } from '../middleware/error-handler.js';
const router = express.Router();

// POST /api/chat
router.post('/', async (req, res) => {
    try {
        const chatHandler = await import('../../services/chat/chat-handler.js');
        return chatHandler.handleChat(req, res);
    } catch (error) {
        console.error('[Chat Route] Error:', error);
        return sendHttpError(res, error, { fallbackMessage: '聊天服务暂时不可用' });
    }
});

// POST /api/chat/stream - 流式响应
router.post('/stream', async (req, res) => {
    try {
        const chatHandler = await import('../../services/chat/chat-handler.js');
        return chatHandler.handleChatStream(req, res);
    } catch (error) {
        console.error('[Chat Route] Stream Error:', error);
        return sendHttpError(res, error, { fallbackMessage: '聊天流式服务暂时不可用' });
    }
});

export default router;
