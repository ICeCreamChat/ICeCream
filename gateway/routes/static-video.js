import fetch from 'node-fetch';

export function normalizeManimServiceUrl(value) {
    let normalized = value || 'http://localhost:8001';

    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
        normalized = `http://${normalized}`;
    }

    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export function createStaticVideoProxy(options = {}) {
    const {
        fetchImpl = fetch,
        logger = console,
        manimServiceUrl = process.env.MANIM_SERVICE_URL || 'http://localhost:8001',
    } = options;

    return async function staticVideoProxy(req, res) {
        const targetUrl = `${normalizeManimServiceUrl(manimServiceUrl)}${req.originalUrl}`;

        try {
            const response = await fetchImpl(targetUrl);

            if (!response.ok) {
                return res.status(response.status).send('Video not found');
            }

            const contentType = response.headers.get('content-type');
            const contentLength = response.headers.get('content-length');

            if (contentType) res.setHeader('Content-Type', contentType);
            if (contentLength) res.setHeader('Content-Length', contentLength);

            if (response.body) {
                response.body.pipe(res);
            } else {
                res.end();
            }
        } catch (error) {
            logger.error('[Video Proxy Error]', error);
            res.status(500).send('Proxy error');
        }
    };
}

export function registerStaticVideoProxy(app, options = {}) {
    app.get('/static/*.mp4', createStaticVideoProxy(options));
}
