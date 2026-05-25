import { access, unlink } from 'node:fs/promises';

import express from 'express';

import { upload } from '../middleware/upload.js';
import { getGeoGebraCommandIndexStatus, normalizeSearchLimit, searchGeoGebraCommands } from '../../services/geogebra/command-search.js';
import { adjustGeoGebraStudio, createGeoGebraAgentStep, createGeoGebraPlan, hasGeoGebraAiConfig, repairGeoGebraPlan } from '../../services/geogebra/geogebra-agent.js';
import { createGeoGebraImagePlan } from '../../services/geogebra/geogebra-image-agent.js';
import { getGeoGebraManualIndexStatus, normalizeManualSearchLimit, searchGeoGebraManual } from '../../services/geogebra/manual-search.js';
import { createGeoGebraCoursewarePackage, GEOGEBRA_COURSEWARE_MIME } from '../../services/geogebra/courseware-export.js';

const router = express.Router();
const GEOGEBRA_DEPLOY_URL = new URL('../../public/vendor/geogebra/deployggb.js', import.meta.url);
const GEOGEBRA_LICENSE = 'GeoGebra Non-Commercial License';

async function geogebraAssetsAvailable() {
    try {
        await access(GEOGEBRA_DEPLOY_URL);
        return true;
    } catch {
        return false;
    }
}

function sendGeoGebraError(res, error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    return res.status(status).json({
        success: false,
        error: error.message || 'GeoGebra 服务暂时不可用',
    });
}

router.get('/status', async (req, res) => {
    const indexStatus = getGeoGebraCommandIndexStatus();
    const manualStatus = getGeoGebraManualIndexStatus();
    return res.json({
        success: true,
        data: {
            assetsAvailable: await geogebraAssetsAvailable(),
            aiAvailable: hasGeoGebraAiConfig(),
            commandIndexReady: indexStatus.ready,
            commandCount: indexStatus.commandCount,
            manualIndexReady: manualStatus.ready,
            manualEntryCount: manualStatus.entryCount,
            license: GEOGEBRA_LICENSE,
        },
    });
});

router.get('/commands/search', (req, res) => {
    const query = String(req.query.q || req.query.query || '');
    const limit = normalizeSearchLimit(req.query.limit);
    return res.json({
        success: true,
        data: {
            query,
            matches: searchGeoGebraCommands(query, limit),
        },
    });
});

router.get('/manual/search', (req, res) => {
    const query = String(req.query.q || req.query.query || '');
    const limit = normalizeManualSearchLimit(req.query.limit);
    const status = getGeoGebraManualIndexStatus();
    return res.json({
        success: true,
        data: {
            query,
            ready: status.ready,
            matches: searchGeoGebraManual(query, limit),
        },
    });
});

router.post('/plan', async (req, res) => {
    try {
        const planPayload = await createGeoGebraPlan(req.body);
        return res.json(planPayload);
    } catch (error) {
        console.error('[GeoGebra Route] Plan Error:', error);
        return sendGeoGebraError(res, error);
    }
});

router.post('/repair', async (req, res) => {
    try {
        const repairPayload = await repairGeoGebraPlan(req.body);
        return res.json(repairPayload);
    } catch (error) {
        console.error('[GeoGebra Route] Repair Error:', error);
        return sendGeoGebraError(res, error);
    }
});

router.post('/studio/adjust', async (req, res) => {
    try {
        const adjustPayload = await adjustGeoGebraStudio(req.body);
        return res.json(adjustPayload);
    } catch (error) {
        console.error('[GeoGebra Route] Studio Adjust Error:', error);
        return sendGeoGebraError(res, error);
    }
});

router.post('/studio/agent-step', async (req, res) => {
    try {
        const stepPayload = await createGeoGebraAgentStep(req.body);
        return res.json(stepPayload);
    } catch (error) {
        console.error('[GeoGebra Route] Studio Agent Step Error:', error);
        return sendGeoGebraError(res, error);
    }
});

router.post('/studio/parse-image', upload.single('image'), async (req, res) => {
    const imageFile = req.file;
    try {
        const imagePayload = await createGeoGebraImagePlan(req.body, imageFile?.path);
        return res.json(imagePayload);
    } catch (error) {
        console.error('[GeoGebra Route] Studio Image Parse Error:', error);
        return sendGeoGebraError(res, error);
    } finally {
        if (imageFile?.path) {
            unlink(imageFile.path).catch(() => {});
        }
    }
});

router.post('/export/courseware', async (req, res) => {
    try {
        const packagePayload = await createGeoGebraCoursewarePackage(req.body);
        res.setHeader('Content-Type', GEOGEBRA_COURSEWARE_MIME);
        res.setHeader('Content-Disposition', `attachment; filename="${packagePayload.filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.send(packagePayload.buffer);
    } catch (error) {
        if (!Number.isInteger(error.status) || error.status >= 500) {
            console.error('[GeoGebra Route] Courseware Export Error:', error);
        }
        return sendGeoGebraError(res, error);
    }
});

export default router;
