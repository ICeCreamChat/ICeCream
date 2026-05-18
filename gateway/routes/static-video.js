import fetch from 'node-fetch';

const ALLOWED_STATIC_EXTENSIONS = new Set(['.mp4', '.png', '.jpg', '.jpeg', '.webp']);

export function normalizeManimServiceUrl(value) {
    let normalized = value || 'http://localhost:8001';

    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
        normalized = `http://${normalized}`;
    }

    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export function isAllowedManimStaticFilename(filename) {
    if (typeof filename !== 'string' || !filename) return false;
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return false;

    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex <= 0) return false;

    return ALLOWED_STATIC_EXTENSIONS.has(filename.slice(dotIndex).toLowerCase());
}

export function createStaticVideoProxy(options = {}) {
    const {
        fetchImpl = fetch,
        logger = console,
        manimServiceUrl = process.env.MANIM_SERVICE_URL || 'http://localhost:8001',
    } = options;

    return async function staticVideoProxy(req, res) {
        const filename = req.params?.filename || '';
        if (!isAllowedManimStaticFilename(filename)) {
            return res.status(404).send('Static asset not found');
        }

        const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
        const targetUrl = `${normalizeManimServiceUrl(manimServiceUrl)}/static/${encodeURIComponent(filename)}${query}`;

        try {
            const response = await fetchImpl(targetUrl);

            if (!response.ok) {
                return res.status(response.status).send('Static asset not found');
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
            logger.error('[Manim Static Proxy Error]', error);
            res.status(500).send('Proxy error');
        }
    };
}

export function registerStaticVideoProxy(app, options = {}) {
    app.get('/static/:filename', createStaticVideoProxy(options));
}
