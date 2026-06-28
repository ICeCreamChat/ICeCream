import crypto from 'node:crypto';

function createRequestId() {
    return crypto.randomUUID?.() || `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeRequestId(value) {
    const text = String(value || '').trim();
    if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(text)) return null;
    return text;
}

export function createRequestIdMiddleware() {
    return function requestIdMiddleware(req, res, next) {
        const requestId = sanitizeRequestId(req.get?.('x-request-id')) || createRequestId();
        req.requestId = requestId;
        res.setHeader?.('x-request-id', requestId);
        next();
    };
}

export function mapGatewayError(err, options = {}) {
    const status = err.statusCode || err.status || 500;
    const requestId = options.requestId || null;
    const data = err.data && typeof err.data === 'object' ? { ...err.data } : {};
    delete data.success;
    delete data.error;
    delete data.requestId;
    if (status >= 500) {
        const payload = {
            success: false,
            error: '服务暂时不可用，请稍后重试',
            requestId,
        };
        if (options.isDev) {
            payload.details = err.message || 'Internal Server Error';
        }
        return { status, payload };
    }

    return {
        status,
        payload: {
            success: false,
            error: err.message || 'Bad Request',
            requestId,
            ...data,
        },
    };
}

export function createErrorHandler(logger = console, options = {}) {
    return function errorHandler(err, req, res, next) {
        const requestId = req?.requestId || null;
        const mapped = mapGatewayError(err, {
            requestId,
            isDev: options.isDev,
        });
        logger.error('[Gateway Error]', {
            requestId,
            status: mapped.status,
            message: err?.message || String(err),
            stack: err?.stack,
        });
        res.status(mapped.status).json(mapped.payload);
    };
}
