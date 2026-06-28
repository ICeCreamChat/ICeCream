import dotenv from 'dotenv';

let environmentLoaded = false;

export function loadEnvironment() {
    if (!environmentLoaded) {
        dotenv.config();
        environmentLoaded = true;
    }
}

export function parseIntegerEnv(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseBooleanEnv(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

export function isLoopbackHost(host = '') {
    const normalized = String(host || '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
    return normalized === 'localhost'
        || normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '';
}

function resolveGatewayHost(env = process.env) {
    const allowRemote = parseBooleanEnv(env.ALLOW_REMOTE, false);
    const requestedHost = String(env.HOST || '').trim();
    if (!requestedHost) return allowRemote ? '0.0.0.0' : '127.0.0.1';
    if (allowRemote || isLoopbackHost(requestedHost)) return requestedHost;
    return '127.0.0.1';
}

export function getLocalApiToken(env = process.env) {
    return String(env.ICECREAM_LOCAL_TOKEN || env.ICECREAM_ADMIN_TOKEN || '').trim();
}

export function getGatewayConfig(env = process.env) {
    const allowRemote = parseBooleanEnv(env.ALLOW_REMOTE, false);
    return {
        port: parseIntegerEnv(env.PORT, 3000),
        host: resolveGatewayHost(env),
        allowRemote,
        localApiToken: getLocalApiToken(env),
        isDev: env.NODE_ENV !== 'production',
        jsonBodyLimit: env.JSON_BODY_LIMIT || '20mb',
        formBodyLimit: env.FORM_BODY_LIMIT || '20mb',
        apiRateLimitPerMinute: parseIntegerEnv(env.API_RATE_LIMIT_PER_MINUTE, 120),
        manimRenderRateLimitPerMinute: parseIntegerEnv(env.MANIM_RENDER_RATE_LIMIT_PER_MINUTE, 6),
        ocrRateLimitPerMinute: parseIntegerEnv(env.OCR_RATE_LIMIT_PER_MINUTE, 8),
        manimServiceUrl: env.MANIM_SERVICE_URL || 'http://localhost:8001',
    };
}

export function validateGatewayEnv(env = process.env, logger = console) {
    const warnings = [];
    const allowRemote = parseBooleanEnv(env.ALLOW_REMOTE, false);
    const requestedHost = String(env.HOST || '').trim();

    if (!env.DEEPSEEK_API_BASE) {
        warnings.push('DEEPSEEK_API_BASE is missing. Chat, Manim, and Solver features will not work.');
    }

    if (!env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY.includes('your_')) {
        warnings.push('DEEPSEEK_API_KEY is missing or still uses a placeholder value.');
    }

    if (!env.SILICONFLOW_API_KEY || env.SILICONFLOW_API_KEY.includes('your_')) {
        warnings.push('SILICONFLOW_API_KEY is missing or still uses a placeholder value.');
    }

    if (requestedHost && !allowRemote && !isLoopbackHost(requestedHost)) {
        warnings.push('HOST is non-loopback but ALLOW_REMOTE is not true. Gateway will bind to 127.0.0.1 for safety.');
    }

    if (allowRemote && !getLocalApiToken(env)) {
        warnings.push('ALLOW_REMOTE=true requires ICECREAM_LOCAL_TOKEN or ICECREAM_ADMIN_TOKEN before startup.');
    }

    if (warnings.length > 0) {
        logger.log('\n[WARN] Environment configuration warnings:');
        warnings.forEach(warning => logger.log(`   - ${warning}`));
        logger.log('   Please update .env with valid API keys when using dependent features.\n');
    }

    return warnings;
}
