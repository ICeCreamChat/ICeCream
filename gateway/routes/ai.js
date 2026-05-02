import express from 'express';
import fetch from 'node-fetch';

import { checkAiStatus } from '../services/ai-status.js';

const router = express.Router();

router.get('/status', async (req, res) => {
    try {
        const data = await checkAiStatus({
            env: process.env,
            fetchImpl: fetch,
        });
        res.json({ success: true, data });
    } catch {
        res.json({
            success: true,
            data: {
                online: false,
                label: 'ICeCream Offline',
                checkedAt: new Date().toISOString(),
                cached: false,
                reason: 'probe_failed',
            },
        });
    }
});

export default router;
