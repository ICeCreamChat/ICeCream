import path from 'node:path';

const IMAGE_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
]);

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

const DANGEROUS_PYTHON_PATTERNS = [
    /\b(?:import|from)\s+(?:os|sys|subprocess|socket|pathlib|shutil|ctypes|signal|multiprocessing|threading|asyncio|requests|urllib|http|ftplib|paramiko)\b/i,
    /\b(?:open|exec|eval|compile|__import__|input|breakpoint)\s*\(/i,
    /\b(?:globals|locals|vars|dir|getattr|setattr|delattr)\s*\(/i,
    /__\w+__/,
    /\b(?:os|subprocess|socket|shutil|pathlib)\s*\./i,
];

export function sanitizeUploadFilename(originalName = 'upload') {
    const normalized = String(originalName || 'upload').replace(/\\/g, '/');
    const baseName = path.basename(normalized).normalize('NFKC');
    const cleaned = baseName
        .replace(/[^\p{L}\p{N}._() -]+/gu, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 120);

    return cleaned || 'upload';
}

export function isAllowedImageMime(mimeType = '') {
    return IMAGE_MIME_TYPES.has(String(mimeType).toLowerCase());
}

export function isAllowedImageExtension(fileName = '') {
    return IMAGE_EXTENSIONS.has(path.extname(String(fileName)).toLowerCase());
}

export function imageUploadFilter(req, file, cb) {
    if (isAllowedImageMime(file.mimetype) && isAllowedImageExtension(file.originalname)) {
        cb(null, true);
        return;
    }

    const error = new Error('仅支持 JPG、PNG、WEBP 或 GIF 图片');
    error.statusCode = 400;
    cb(error);
}

export function normalizeClientId(value, fallback = 'gateway') {
    const id = String(value || '').trim();
    if (!id) return fallback;
    return id.replace(/[^\w.-]/g, '_').slice(0, 80) || fallback;
}

export function validateManimCode(code) {
    if (typeof code !== 'string' || !code.trim()) {
        return { valid: false, reason: '代码不能为空' };
    }

    if (code.length > 60000) {
        return { valid: false, reason: '代码过长，请控制在 60000 字符以内' };
    }

    for (const pattern of DANGEROUS_PYTHON_PATTERNS) {
        if (pattern.test(code)) {
            return { valid: false, reason: '代码包含不允许的系统访问或动态执行语句' };
        }
    }

    return { valid: true };
}

export function createRateLimiter({ windowMs, max, message = '请求过于频繁，请稍后再试' }) {
    const hits = new Map();

    return function rateLimiter(req, res, next) {
        const now = Date.now();
        const key = `${req.ip || req.socket?.remoteAddress || 'unknown'}:${req.baseUrl || ''}:${req.path || ''}`;
        const bucket = hits.get(key) || { count: 0, resetAt: now + windowMs };

        if (bucket.resetAt <= now) {
            bucket.count = 0;
            bucket.resetAt = now + windowMs;
        }

        bucket.count += 1;
        hits.set(key, bucket);

        if (bucket.count > max) {
            res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
            return res.status(429).json({ success: false, error: message });
        }

        // Lazy cleanup: only scan stale buckets when the in-memory map grows large.
        // For higher concurrency or multi-instance deployment, replace with Redis.
        if (hits.size > 10000) {
            for (const [hitKey, value] of hits) {
                if (value.resetAt <= now) hits.delete(hitKey);
            }
        }

        next();
    };
}

export function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
}

export function buildCorsOptions() {
    const configuredOrigins = (process.env.CORS_ORIGIN || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean);

    const allowedOrigins = configuredOrigins.length > 0
        ? configuredOrigins
        : [
            'http://localhost:3000',
            'http://127.0.0.1:3000',
        ];

    return {
        origin(origin, callback) {
            // Allow no-origin requests (same-origin server calls, curl, local scripts).
            // If production requires stricter policy, reject when origin is missing.
            if (!origin || allowedOrigins.includes(origin)) {
                callback(null, true);
                return;
            }

            callback(new Error('Not allowed by CORS'));
        },
    };
}
