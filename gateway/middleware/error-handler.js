export function createErrorHandler(logger = console) {
    return function errorHandler(err, req, res, next) {
        logger.error('[Gateway Error]', err);
        const status = err.statusCode || err.status || 500;
        res.status(status).json({
            success: false,
            error: status >= 500 ? 'Internal Server Error' : (err.message || 'Bad Request'),
        });
    };
}
