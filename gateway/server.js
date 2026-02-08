/**
 * ICeCream - 统一智能平台 Gateway 服务
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 */

import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import dotenv from 'dotenv';
import multer from 'multer';
import dns from 'node:dns';
import http from 'http';

// Force usage of IPv4 for DNS resolution to avoid timeouts on some networks
try {
    dns.setDefaultResultOrder('ipv4first');
} catch (e) {
    // Ignore if not supported (older Node versions)
}

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ================================
// Ensure required directories exist
// ================================
const uploadsDir = join(__dirname, '../uploads');
if (!existsSync(uploadsDir)) {
    mkdirSync(uploadsDir, { recursive: true });
    console.log('[INIT] Created uploads directory');
}

// ================================
// Validate environment variables
// ================================
const validateEnv = () => {
    const warnings = [];

    if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY.includes('your_')) {
        warnings.push('DEEPSEEK_API_KEY 未配置或仍为占位符');
    }

    if (!process.env.SILICONFLOW_API_KEY || process.env.SILICONFLOW_API_KEY.includes('your_')) {
        warnings.push('SILICONFLOW_API_KEY 未配置（解题功能需要）');
    }

    if (warnings.length > 0) {
        console.log('\n⚠️  环境配置警告:');
        warnings.forEach(w => console.log(`   - ${w}`));
        console.log('   请编辑 .env 文件填入有效的 API Key\n');
    }

    return warnings.length === 0;
};

validateEnv();

const app = express();
const PORT = process.env.PORT || 3000;

// ================================
// Middleware
// ================================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ================================
// Request Logging (Dev Mode)
// ================================
const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
    app.use((req, res, next) => {
        const start = Date.now();
        const timestamp = new Date().toISOString().slice(11, 19);

        // Log request
        console.log(`\n[${timestamp}] --> ${req.method} ${req.url}`);
        if (req.body && Object.keys(req.body).length > 0) {
            const body = { ...req.body };
            // Truncate long content
            if (body.message && body.message.length > 100) {
                body.message = body.message.slice(0, 100) + '...';
            }
            if (body.imageBase64) {
                body.imageBase64 = '[BASE64 IMAGE]';
            }
            console.log(`    Body: ${JSON.stringify(body)}`);
        }

        // Capture response
        const originalSend = res.send;
        res.send = function (data) {
            const duration = Date.now() - start;
            console.log(`[${timestamp}] <-- ${res.statusCode} (${duration}ms)`);
            return originalSend.call(this, data);
        };

        next();
    });
}



// Proxy static video files to Manim service (running on 8001)
// This is needed because Manim service returns relative URLs like /static/video_xxx.mp4
app.get('/static/*.mp4', (req, res) => {
    const manimServiceUrl = process.env.MANIM_SERVICE_URL || 'http://localhost:8001';
    const targetUrl = `${manimServiceUrl}${req.originalUrl}`;

    http.get(targetUrl, (proxyRes) => {
        if (proxyRes.statusCode !== 200) {
            return res.status(404).send('Video not found');
        }
        res.writeHead(200, proxyRes.headers);
        proxyRes.pipe(res);
    }).on('error', (e) => {
        console.error('[Video Proxy Error]', e);
        res.status(500).send('Proxy error');
    });
});

// Static files
app.use(express.static(join(__dirname, '../public')));

// File upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, join(__dirname, '../uploads'));
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB limit

// ================================
// Intent Router Middleware
// ================================
import { intentRouter } from './middleware/intent-router.js';

// ================================
// API Routes
// ================================

// Unified message endpoint with intent routing
app.post('/api/message', upload.single('image'), intentRouter);

// Direct service endpoints (bypass intent routing)
import chatRoutes from './routes/chat.js';
import manimRoutes from './routes/manim.js';
import solverRoutes from './routes/solver.js';

app.use('/api/chat', chatRoutes);
app.use('/api/manim', manimRoutes);
app.use('/api/solver', upload.single('image'), solverRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'ICeCream Gateway',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

// ================================
// Frontend Log Bridge (Dev Mode)
// ================================
if (isDev) {
    app.post('/api/log', (req, res) => {
        const { level, message, data } = req.body;
        const timestamp = new Date().toISOString().slice(11, 19);
        const prefix = `[${timestamp}] [FRONTEND]`;

        switch (level) {
            case 'error':
                console.error(`${prefix} ❌ ${message}`, data || '');
                break;
            case 'warn':
                console.warn(`${prefix} ⚠️  ${message}`, data || '');
                break;
            case 'info':
                console.log(`${prefix} ℹ️  ${message}`, data || '');
                break;
            default:
                console.log(`${prefix} 📝 ${message}`, data || '');
        }

        res.json({ received: true });
    });
}

// ================================
// Error Handling
// ================================
app.use((err, req, res, next) => {
    console.error('[Gateway Error]', err);
    res.status(500).json({
        success: false,
        error: err.message || 'Internal Server Error'
    });
});

// ================================
// Start Server
// ================================
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   🍦 ICeCream Gateway Server                          ║
║                                                       ║
║   Local:   http://localhost:${PORT}                     ║
║   Status:  Ready                                      ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
    `);
    console.log('[INFO] Intent Classifier:', process.env.INTENT_CLASSIFIER_ENABLED === 'true' ? 'Enabled' : 'Disabled');
    console.log('[INFO] DeepSeek API:', process.env.DEEPSEEK_API_KEY ? 'Configured' : 'Not configured');
    console.log('[INFO] SiliconFlow API:', process.env.SILICONFLOW_API_KEY ? 'Configured' : 'Not configured');
});

export default app;
