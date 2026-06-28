/**
 * ICeCream Gateway service bootstrap.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { createGatewayApp } from './app.js';
import { getGatewayConfig, loadEnvironment, validateGatewayEnv } from './config/environment.js';
import { gatewayPaths } from './config/paths.js';
import { logStartupBanner } from './startup/banner.js';
import { preferIpv4Dns } from './startup/dns.js';
import { prepareUploadsDirectory } from './startup/uploads.js';

export function startGateway(options = {}) {
    loadEnvironment();
    preferIpv4Dns();

    const config = {
        ...getGatewayConfig(),
        ...options,
    };

    validateGatewayEnv(process.env, config.logger || console);
    if (config.allowRemote && !config.localApiToken) {
        throw new Error('ALLOW_REMOTE=true requires ICECREAM_LOCAL_TOKEN or ICECREAM_ADMIN_TOKEN');
    }
    prepareUploadsDirectory(config.uploadsDir || gatewayPaths.uploadsDir, {
        logger: config.logger || console,
    });

    const app = createGatewayApp(config);
    const server = app.listen(config.port, config.host, () => {
        logStartupBanner(config, config.logger || console);
    });

    return { app, server, config };
}

const isDirectRun = process.argv[1]
    ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
    : false;

const started = isDirectRun ? startGateway() : null;

export const app = started?.app || createGatewayApp();
export const server = started?.server;
export default app;
