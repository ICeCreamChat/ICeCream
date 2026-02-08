/**
 * Manim Routes - 直接访问 Manim 服务的路由
 */

import express from 'express';
const router = express.Router();

// POST /api/manim - 生成动画
router.post('/', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.handleManim(req, res);
    } catch (error) {
        console.error('[Manim Route] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/manim/render - 渲染代码
router.post('/render', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.renderCode(req, res);
    } catch (error) {
        console.error('[Manim Route] Render Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/manim/status - 服务状态
router.get('/status', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.getStatus(req, res);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
