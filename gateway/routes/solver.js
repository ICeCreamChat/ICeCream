/**
 * Solver Routes - 直接访问解题服务的路由
 */

import express from 'express';
import { upload } from '../middleware/upload.js';
import { sendHttpError } from '../middleware/error-handler.js';
const router = express.Router();

// POST /api/solver - 解题
router.post('/', upload.single('image'), async (req, res) => {
    try {
        const solverHandler = await import('../../services/solver/solver-handler.js');
        return solverHandler.handleSolve(req, res);
    } catch (error) {
        console.error('[Solver Route] Error:', error);
        return sendHttpError(res, error, { fallbackMessage: '解题服务暂时不可用' });
    }
});

// POST /api/solver/chat - 解题后追问
router.post('/chat', async (req, res) => {
    try {
        const solverHandler = await import('../../services/solver/solver-handler.js');
        return solverHandler.handleFollowUp(req, res);
    } catch (error) {
        console.error('[Solver Route] Chat Error:', error);
        return sendHttpError(res, error, { fallbackMessage: '解题追问服务暂时不可用' });
    }
});

export default router;
