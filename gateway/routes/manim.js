import express from 'express';
import { upload } from '../middleware/upload.js';
import { sendHttpError } from '../middleware/error-handler.js';

const router = express.Router();

router.post('/', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.handleManim(req, res);
    } catch (error) {
        console.error('[Manim Route] Error:', error);
        return sendHttpError(res, error, { fallbackMessage: 'Manim 服务暂时不可用' });
    }
});

router.post('/agent/stream', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.streamAgent(req, res);
    } catch (error) {
        console.error('[Manim Route] Agent Stream Error:', error);
        return sendHttpError(res, error, { fallbackMessage: 'Manim 流式服务暂时不可用' });
    }
});

router.post('/intent', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.classifyManimIntent(req, res);
    } catch (error) {
        console.error('[Manim Route] Intent Error:', error);
        return sendHttpError(res, error, { fallbackMessage: 'Manim 意图服务暂时不可用' });
    }
});

router.post('/render', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.renderCode(req, res);
    } catch (error) {
        console.error('[Manim Route] Render Error:', error);
        return sendHttpError(res, error, { fallbackMessage: 'Manim 渲染服务暂时不可用' });
    }
});

router.post('/suggestions', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.getSuggestions(req, res);
    } catch (error) {
        console.error('[Manim Route] Suggestions Error:', error);
        return sendHttpError(res, error, { fallbackMessage: 'Manim 建议服务暂时不可用' });
    }
});

router.get('/status', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.getStatus(req, res);
    } catch (error) {
        return sendHttpError(res, error, { fallbackMessage: 'Manim 状态服务暂时不可用' });
    }
});

router.get('/skills', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.listSkills(req, res);
    } catch (error) {
        return sendHttpError(res, error, { fallbackMessage: 'Manim 能力列表暂时不可用' });
    }
});

router.get('/jobs', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.listJobs(req, res);
    } catch (error) {
        return sendHttpError(res, error, { fallbackMessage: 'Manim 任务列表暂时不可用' });
    }
});

router.get('/jobs/:jobId', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.getJob(req, res);
    } catch (error) {
        return sendHttpError(res, error, { fallbackMessage: 'Manim 任务详情暂时不可用' });
    }
});

router.post('/jobs/:jobId/cancel', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.cancelJob(req, res);
    } catch (error) {
        return sendHttpError(res, error, { fallbackMessage: 'Manim 任务取消暂时不可用' });
    }
});

router.get('/failures', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.listFailures(req, res);
    } catch (error) {
        return sendHttpError(res, error, { fallbackMessage: 'Manim 失败列表暂时不可用' });
    }
});

router.post('/failures/:eventId/replay', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.replayFailure(req, res);
    } catch (error) {
        return sendHttpError(res, error, { fallbackMessage: 'Manim 失败回放暂时不可用' });
    }
});

router.post('/reference-images', upload.single('image'), async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.uploadReferenceImage(req, res);
    } catch (error) {
        return sendHttpError(res, error, { fallbackMessage: '参考图上传暂时不可用' });
    }
});

router.post('/patch', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.patchScene(req, res);
    } catch (error) {
        return sendHttpError(res, error, { fallbackMessage: 'Manim 补丁服务暂时不可用' });
    }
});

router.post('/layout-rebuild', async (req, res) => {
    try {
        const manimClient = await import('../../services/manim/manim-client.js');
        return manimClient.layoutRebuild(req, res);
    } catch (error) {
        return sendHttpError(res, error, { fallbackMessage: 'Manim 布局重建暂时不可用' });
    }
});

export default router;
