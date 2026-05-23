import multer from 'multer';
import { gatewayPaths } from '../config/paths.js';
import { imageUploadFilter, sanitizeUploadFilename } from '../security.js';

const imageUploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, gatewayPaths.uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${uniqueSuffix}-${sanitizeUploadFilename(file.originalname)}`);
    }
});

export const upload = multer({
    storage: imageUploadStorage,
    fileFilter: imageUploadFilter,
    limits: { fileSize: 20 * 1024 * 1024 }
});
