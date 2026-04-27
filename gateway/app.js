import express from 'express';

import { getGatewayConfig, loadEnvironment } from './config/environment.js';
import { gatewayPaths } from './config/paths.js';
import { registerCoreMiddleware } from './middleware/core.js';
import { createErrorHandler } from './middleware/error-handler.js';
import { createRequestLogger } from './middleware/request-logger.js';
import { registerApiRoutes } from './routes/index.js';
import { registerFrontendLogRoute } from './routes/frontend-log.js';
import { registerHealthRoute } from './routes/health.js';
import { registerStaticVideoProxy } from './routes/static-video.js';

export function createGatewayApp(options = {}) {
    loadEnvironment();

    const config = {
        ...getGatewayConfig(),
        ...options,
    };

    const app = express();
    app.set('trust proxy', 1);

    registerCoreMiddleware(app, config);

    if (config.isDev) {
        app.use(createRequestLogger(config.logger || console));
    }

    registerStaticVideoProxy(app, {
        manimServiceUrl: config.manimServiceUrl,
        logger: config.logger || console,
    });

    app.use(express.static(config.publicDir || gatewayPaths.publicDir));

    registerApiRoutes(app);
    registerHealthRoute(app);

    if (config.isDev) {
        registerFrontendLogRoute(app, config.logger || console);
    }

    app.use(createErrorHandler(config.logger || console));

    return app;
}
