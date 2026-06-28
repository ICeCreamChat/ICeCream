import express from 'express';
import fetch from 'node-fetch';
import { parseSeatingConstraints } from '../../../services/seating-constraints.js';

const router = express.Router();

/**
 * POST /api/tools/seating/parse
 * 自然语言约束解析 → JSON
 */
router.post('/parse', async (req, res) => {
    try {
        const { text, students } = req.body;
        if (!text) {
            return res.status(400).json({                success: false,                error: '请提供约束描述文本'            });
        }

        const parsed = await parseSeatingConstraints({
            text,
            students,
            fetchImpl: fetch,
            env: process.env,
        });

        res.json({
            success: true,
            data: {
                constraints: parsed.constraints || [],
                raw: parsed.raw,
                warnings: parsed.warnings || [],
                source: parsed.source,
            }
        });

    } catch (error) {
        console.error('[Tools/Seating/Parse] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
