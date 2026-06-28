import crypto from 'node:crypto';
import { STATUS_CODES } from 'node:http';

function createRequestId() {
    return crypto.randomUUID?.() || `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeRequestId(value) {
    const text = String(value || '').trim();
    if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(text)) return null;
    return text;
}

function fallbackStatusMessage(status) {
    return STATUS_CODES[status] || (status >= 500 ? 'Internal Server Error' : 'Bad Request');
}

export function createRequestIdMiddleware() {
    return function requestIdMiddleware(req, res, next) {
        const requestId = sanitizeRequestId(req.get?.('x-request-id')) || createRequestId();
        req.requestId = requestId;
        res.setHeader?.('x-request-id', requestId);
        next();
    };
}

export function getPublicErrorMessage(error, status = 500, options = {}) {
    const fallbackMessage = String(options.fallbackMessage || '').trim() || fallbackStatusMessage(status);
    const rawMessage = String(error?.message || error || '').trim();

    if (error?.publicMessage) {
        const publicMessage = String(error.publicMessage).trim();
        if (publicMessage) return publicMessage;
    }

    if (error?.expose === true) {
        return rawMessage || fallbackMessage;
    }

    if (status < 500 && error?.expose !== false) {
        return rawMessage || fallbackMessage;
    }

    return fallbackMessage;
}

export function sendHttpError(res, error, options = {}) {
    const status = Number(options.status ?? error?.statusCode ?? error?.status ?? 500) || 500;
    const payload = {
        success: false,
        error: getPublicErrorMessage(error, status, options),
    };
    if (options.data !== undefined) {
        payload.data = options.data;
    }
    return res.status(status).json(payload);
}

export function createHttpError(message, status = 500, options = {}) {
    const error = new Error(String(message || fallbackStatusMessage(status)));
    error.status = status;
    if (options.expose !== undefined) error.expose = options.expose;
    if (options.publicMessage !== undefined) error.publicMessage = options.publicMessage;
    if (options.code !== undefined) error.code = options.code;
    if (options.data !== undefined) error.data = options.data;
    return error;
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
