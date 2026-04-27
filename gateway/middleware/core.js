import cors from 'cors';
import express from 'express';

import {
    buildCorsOptions,
    createRateLimiter,
    securityHeaders,
} from '../security.js';

export function registerCoreMiddleware(app, config) {
    app.use(securityHeaders);
    app.use(cors(buildCorsOptions()));
    app.use('/api/', createRateLimiter({
        windowMs: 60 * 1000,
        max: config.apiRateLimitPerMinute,
    }));
    app.use('/api/manim/render', createRateLimiter({
        windowMs: 60 * 1000,
        max: config.manimRenderRateLimitPerMinute,
        message: 'Animation render requests are too frequent. Please try again later.',
    }));
    app.use('/api/tools/seating/parse-image', createRateLimiter({
        windowMs: 60 * 1000,
        max: config.ocrRateLimitPerMinute,
        message: 'Image recognition requests are too frequent. Please try again later.',
    }));
    app.use(express.json({ limit: config.jsonBodyLimit }));
    app.use(express.urlencoded({ extended: true, limit: config.formBodyLimit }));
}
