import express from 'express';
import { upload } from '../middleware/upload.js';
import { requireLocalApiToken } from '../security.js';

const router = express.Router();
const adminGuard = requireLocalApiToken({
    token: () => process.env.ICECREAM_LOCAL_TOKEN || process.env.ICECREAM_ADMIN_TOKEN || '',
    allowLoopback: true,
});

router.post('/', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.handleManim(req, res);
    } catch (error) {
        console.error('[Manim Route] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/agent/stream', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.streamAgent(req, res);
    } catch (error) {
        console.error('[Manim Route] Agent Stream Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/intent', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.classifyManimIntent(req, res);
    } catch (error) {
        console.error('[Manim Route] Intent Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/render', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.renderCode(req, res);
    } catch (error) {
        console.error('[Manim Route] Render Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/suggestions', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.getSuggestions(req, res);
    } catch (error) {
        console.error('[Manim Route] Suggestions Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/status', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.getStatus(req, res);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/skills', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.listSkills(req, res);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/jobs', adminGuard, async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.listJobs(req, res);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/jobs/:jobId', adminGuard, async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.getJob(req, res);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/jobs/:jobId/cancel', adminGuard, async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.cancelJob(req, res);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/failures', adminGuard, async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.listFailures(req, res);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/failures/:eventId/replay', adminGuard, async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.replayFailure(req, res);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/reference-images', adminGuard, upload.single('image'), async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.uploadReferenceImage(req, res);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/patch', adminGuard, async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.patchScene(req, res);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/layout-rebuild', adminGuard, async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.layoutRebuild(req, res);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
