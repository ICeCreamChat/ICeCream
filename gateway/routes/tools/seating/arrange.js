import express from 'express';
import fetch from 'node-fetch';
import {
    normalizeArrangeRequest,
    requestArrangementSpec,
    runAiLayoutPreview,
    runAiDrivenArrangement,
} from '../../../services/seating-arrange.js';

const router = express.Router();

/**
 * POST /api/tools/seating/layout-spec
 * Recognize natural-language layout rules without generating a matrix.
 */
router.post('/layout-spec', async (req, res) => {
    let arrangeRequest;
    try {
        arrangeRequest = normalizeArrangeRequest(req.body, { allowStudentCountOnly: true });
    } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
    }

    try {
        const result = await requestArrangementSpec({
            request: arrangeRequest,
            fetchImpl: fetch,
            env: process.env,
        });
        return res.json({
            success: true,
            data: {
                arrangementSpec: result.spec,
                interpretation: {
                    summary: result.spec.notes || ((result.spec.groupSize || 1) > 1
                        ? `${result.spec.groupSize}人一组`
                        : '单人座位'),
                    assumptions: result.spec.assumptions || [],
                },
                warnings: result.warnings || [],
                source: result.source,
            },
        });
    } catch (error) {
        console.error('[Seating/LayoutSpec] Error:', error.message);
        return res.status(502).json({
            success: false,
            error: error.message || 'AI 排座规则识别暂时不可用',
        });
    }
});

/**
 * POST /api/tools/seating/arrange
 * AI-driven first-pass classroom layout + seating arrangement.
 */
router.post('/arrange', async (req, res) => {
    let arrangeRequest;
    try {
        arrangeRequest = normalizeArrangeRequest(req.body);
    } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
    }

    try {
        const data = await runAiDrivenArrangement({
            request: arrangeRequest,
            fetchImpl: fetch,
            env: process.env,
        });
        return res.json({
            success: true,
            data,
        });
    } catch (error) {
        console.error('[Seating/Arrange] Error:', error.message);
        return res.status(502).json({
            success: false,
            error: error.message || 'AI 排座服务暂时不可用',
        });
    }
});

/**
 * POST /api/tools/seating/layout-preview
 * AI-first empty classroom layout preview. Student assignment happens after confirmation.
 */
router.post('/layout-preview', async (req, res) => {
    let arrangeRequest;
    try {
        arrangeRequest = normalizeArrangeRequest(req.body);
    } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
    }

    try {
        const data = await runAiLayoutPreview({
            request: arrangeRequest,
            fetchImpl: fetch,
            env: process.env,
        });
        return res.json({
            success: true,
            data,
        });
    } catch (error) {
        console.error('[Seating/LayoutPreview] Error:', error.message);
        return res.status(502).json({
            success: false,
            error: error.message || 'AI 布局预览暂时不可用',
        });
    }
});

export default router;
