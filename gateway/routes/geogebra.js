import { access } from 'node:fs/promises';

import express from 'express';

import { getGeoGebraCommandIndexStatus, normalizeSearchLimit, searchGeoGebraCommands } from '../../services/geogebra/command-search.js';
import { adjustGeoGebraStudio, createGeoGebraPlan, hasGeoGebraAiConfig, repairGeoGebraPlan } from '../../services/geogebra/geogebra-agent.js';

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
    return res.json({
        success: true,
        data: {
            assetsAvailable: await geogebraAssetsAvailable(),
            aiAvailable: hasGeoGebraAiConfig(),
            commandIndexReady: indexStatus.ready,
            commandCount: indexStatus.commandCount,
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

export default router;
