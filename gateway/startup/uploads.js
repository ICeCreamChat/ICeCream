import fs from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;

export function ensureDirectory(directoryPath, logger = {}) {
    if (!fs.existsSync(directoryPath)) {
        fs.mkdirSync(directoryPath, { recursive: true });
        logger.log?.(`[INIT] Created directory: ${directoryPath}`);
    }
}

export function cleanupUploadsDirectory(uploadsDir, options = {}) {
    const {
        now = Date.now(),
        maxAgeMs = DEFAULT_UPLOAD_RETENTION_MS,
        logger = console,
    } = options;

    const result = {
        deletedCount: 0,
        errorCount: 0,
    };

    if (!fs.existsSync(uploadsDir)) {
        return result;
    }

    let files = [];
    try {
        files = fs.readdirSync(uploadsDir);
    } catch (error) {
        result.errorCount += 1;
        logger.error?.('[Cleanup] Error reading uploads dir:', error);
        return result;
    }

    files.forEach(file => {
        if (file === '.gitkeep') return;

        const filePath = join(uploadsDir, file);
        try {
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > maxAgeMs) {
                fs.unlinkSync(filePath);
                result.deletedCount += 1;
            }
        } catch {
            result.errorCount += 1;
        }
    });

    return result;
}

export function prepareUploadsDirectory(uploadsDir, options = {}) {
    const {
        logger = console,
        maxAgeMs = DEFAULT_UPLOAD_RETENTION_MS,
    } = options;

    ensureDirectory(uploadsDir, logger);
    logger.log?.('[System] Running startup upload cleanup...');

    const result = cleanupUploadsDirectory(uploadsDir, {
        logger,
        maxAgeMs,
    });

    if (result.deletedCount > 0) {
        logger.log?.(`[System] Startup cleanup complete: deleted ${result.deletedCount} expired upload file(s).`);
    } else {
        logger.log?.('[System] Startup cleanup complete: no expired upload files.');
    }

    return result;
}
