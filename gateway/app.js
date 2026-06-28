import express from 'express';
import path from 'node:path';

import { getGatewayConfig, loadEnvironment } from './config/environment.js';
import { gatewayPaths } from './config/paths.js';
import { registerCoreMiddleware } from './middleware/core.js';
import { createErrorHandler, createRequestIdMiddleware } from './middleware/error-handler.js';
import { createRequestLogger } from './middleware/request-logger.js';
import { registerApiRoutes } from './routes/index.js';
import { registerFrontendLogRoute } from './routes/frontend-log.js';
import { registerHealthRoute } from './routes/health.js';
import { registerStaticVideoProxy } from './routes/static-video.js';

export function setDevelopmentStaticHeaders(res, filePath = '') {
    const normalizedPath = String(filePath).replace(/\\/g, '/');
    if (
        normalizedPath.includes('/public/js/') ||
        normalizedPath.includes('/public/vendor/geogebra/') ||
        normalizedPath.includes('/shared/')
    ) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}

export function createGatewayApp(options = {}) {
    loadEnvironment();

    const config = {
        ...getGatewayConfig(),
        ...options,
    };

    const app = express();
    app.set('trust proxy', 1);
    app.use(createRequestIdMiddleware());

    registerCoreMiddleware(app, config);

    if (config.isDev) {
        app.use(createRequestLogger(config.logger || console));
    }

    registerStaticVideoProxy(app, {
        manimServiceUrl: config.manimServiceUrl,
        logger: config.logger || console,
    });

    app.use(express.static(config.publicDir || gatewayPaths.publicDir, {
        setHeaders: config.isDev ? setDevelopmentStaticHeaders : undefined,
    }));
    app.use('/shared', express.static(path.join(gatewayPaths.projectRoot, 'shared'), {
        setHeaders: config.isDev ? setDevelopmentStaticHeaders : undefined,
    }));

    registerApiRoutes(app);
    registerHealthRoute(app);

    if (config.isDev) {
        registerFrontendLogRoute(app, config.logger || console);
    }

    app.use(createErrorHandler(config.logger || console, { isDev: config.isDev }));

    return app;
}
