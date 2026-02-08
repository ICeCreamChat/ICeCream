/**
 * Solver Routes - 直接访问解题服务的路由
 */

import express from 'express';
const router = express.Router();

// POST /api/solver - 解题
router.post('/', async (req, res) => {
    try {
        const solverHandler = await import('../../services/solver/solver-handler.js');
        return solverHandler.handleSolve(req, res);
    } catch (error) {
        console.error('[Solver Route] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/solver/chat - 解题后追问
router.post('/chat', async (req, res) => {
    try {
        const solverHandler = await import('../../services/solver/solver-handler.js');
        return solverHandler.handleFollowUp(req, res);
    } catch (error) {
        console.error('[Solver Route] Chat Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
