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

export function getGatewayConfig(env = process.env) {
    return {
        port: parseIntegerEnv(env.PORT, 3000),
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

    if (!env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY.includes('your_')) {
        warnings.push('DEEPSEEK_API_KEY is missing or still uses a placeholder value.');
    }

    if (!env.SILICONFLOW_API_KEY || env.SILICONFLOW_API_KEY.includes('your_')) {
        warnings.push('SILICONFLOW_API_KEY is missing or still uses a placeholder value.');
    }

    if (warnings.length > 0) {
        logger.log('\n[WARN] Environment configuration warnings:');
        warnings.forEach(warning => logger.log(`   - ${warning}`));
        logger.log('   Please update .env with valid API keys when using dependent features.\n');
    }

    return warnings;
}
