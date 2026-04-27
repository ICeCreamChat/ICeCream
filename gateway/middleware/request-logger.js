export function createRequestLogger(logger = console) {
    return function requestLogger(req, res, next) {
        const start = Date.now();
        const timestamp = new Date().toISOString().slice(11, 19);

        logger.log(`\n[${timestamp}] --> ${req.method} ${req.url}`);
        if (req.body && Object.keys(req.body).length > 0) {
            const body = { ...req.body };
            if (body.message && body.message.length > 100) {
                body.message = `${body.message.slice(0, 100)}...`;
            }
            if (body.imageBase64) {
                body.imageBase64 = '[BASE64 IMAGE]';
            }
            logger.log(`    Body: ${JSON.stringify(body)}`);
        }

        const originalSend = res.send;
        res.send = function sendWithLogging(data) {
            const duration = Date.now() - start;
            logger.log(`[${timestamp}] <-- ${res.statusCode} (${duration}ms)`);
            return originalSend.call(this, data);
        };

        next();
    };
}
