/**
 * Chat Routes - 直接访问聊天服务的路由
 */

import express from 'express';
const router = express.Router();

// POST /api/chat
router.post('/', async (req, res) => {
    try {
        const chatHandler = await import('../../services/chat/chat-handler.js');
        return chatHandler.handleChat(req, res);
    } catch (error) {
        console.error('[Chat Route] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/chat/stream - 流式响应
router.post('/stream', async (req, res) => {
    try {
        const chatHandler = await import('../../services/chat/chat-handler.js');
        return chatHandler.handleChatStream(req, res);
    } catch (error) {
        console.error('[Chat Route] Stream Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
