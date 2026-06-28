import express from 'express';
import fetch from 'node-fetch';
import {
    generateSeatingSuggestions,
    normalizeSuggestionRequest,
} from '../../../services/seating-suggestions.js';

const router = express.Router();

/**
 * POST /api/tools/seating/suggestions
 * AI-generated rotating prompt suggestions for seating inputs.
 */
router.post('/suggestions', async (req, res) => {
    try {
        const request = normalizeSuggestionRequest(req.body);
        const suggestions = await generateSeatingSuggestions({
            request,
            fetchImpl: fetch,
            env: process.env,
        });
        res.json({
            success: true,
            data: { suggestions },
        });
    } catch (error) {
        console.error('[Seating/Suggestions] Error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message || 'AI 提示暂时不可用',
        });
    }
});

export default router;
