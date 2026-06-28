import express from 'express';
import fetch from 'node-fetch';
import { buildSeatingDiagnostics } from '../../../services/seating-diagnostics.js';
import { submitSeatingFeedback } from '../../../services/seating-feedback.js';

const router = express.Router();

/**
 * POST /api/tools/seating/feedback
 * Save anonymized seating feedback and optionally email it when SMTP is configured.
 */
router.post('/feedback', async (req, res) => {
    try {
        const result = await submitSeatingFeedback({
            body: req.body,
            env: process.env,
        });
        res.json({
            success: true,
            data: {
                id: result.id,
                aiSummarized: false,
                emailSent: result.emailSent,
                emailSkippedReason: result.emailSkippedReason,
            },
        });
    } catch (error) {
        const message = error.message || '反馈提交失败';
        const status = /反馈|message/i.test(message) ? 400 : 500;
        console.error('[Seating/Feedback] Error:', message);
        res.status(status).json({
            success: false,
            error: message,
        });
    }
});

/**
 * GET /api/tools/seating/diagnostics
 * Return redacted runtime diagnostics for feedback reproduction.
 */
router.get('/diagnostics', async (req, res) => {
    try {
        const data = await buildSeatingDiagnostics({
            env: process.env,
            fetchImpl: fetch,
        });
        res.json({ success: true, data });
    } catch (error) {
        console.error('[Seating/Diagnostics] Error:', error.message);
        res.status(500).json({
            success: false,
            error: 'diagnostics_unavailable',
        });
    }
});

export default router;
