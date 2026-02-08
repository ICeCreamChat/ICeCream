/**
 * ICeCream - Image Utilities (Ported from MathSolver)
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Beautify and crop an image based on bounding box coordinates
 * @param {string} imagePath - Path to the source image
 * @param {Array|Object} bbox - Bounding box in format [x1, y1, x2, y2] (pixels or percentages)
 * @returns {Promise<string|null>} - Path to the cropped image, or null on failure
 */
export async function beautifyAndCrop(imagePath, bbox) {
    try {
        if (!bbox) {
            console.log('[ImageUtils] No bbox provided, skipping crop');
            return null;
        }

        const image = sharp(imagePath);
        const metadata = await image.metadata();
        const { width: imgWidth, height: imgHeight } = metadata;

        let left, top, width, height;

        // Handle array format [x1, y1, x2, y2]
        if (Array.isArray(bbox) && bbox.length === 4) {
            let [x1, y1, x2, y2] = bbox.map(v => Number(v) || 0);

            // Check if values are percentages (0-100) vs pixels
            const maxVal = Math.max(x1, y1, x2, y2);
            if (maxVal <= 100 && maxVal > 1) {
                // Percentage format (0-100), convert to pixels
                x1 = Math.round((x1 / 100) * imgWidth);
                y1 = Math.round((y1 / 100) * imgHeight);
                x2 = Math.round((x2 / 100) * imgWidth);
                y2 = Math.round((y2 / 100) * imgHeight);
            }
            // Else assume pixel values

            left = Math.max(0, Math.min(x1, imgWidth - 1));
            top = Math.max(0, Math.min(y1, imgHeight - 1));
            width = Math.max(1, Math.min(x2 - x1, imgWidth - left));
            height = Math.max(1, Math.min(y2 - y1, imgHeight - top));
        }
        // Handle object format {x, y, width, height}
        else if (typeof bbox === 'object' && bbox !== null) {
            left = Number(bbox.x) || Number(bbox.left) || 0;
            top = Number(bbox.y) || Number(bbox.top) || 0;
            width = Number(bbox.width) || Number(bbox.w) || 100;
            height = Number(bbox.height) || Number(bbox.h) || 100;

            // If values are <= 1, treat as normalized (0-1)
            if (left <= 1 && top <= 1 && width <= 1 && height <= 1) {
                left = Math.round(left * imgWidth);
                top = Math.round(top * imgHeight);
                width = Math.round(width * imgWidth);
                height = Math.round(height * imgHeight);
            }

            // Clamp bounds
            left = Math.max(0, Math.min(left, imgWidth - 1));
            top = Math.max(0, Math.min(top, imgHeight - 1));
            width = Math.max(1, Math.min(width, imgWidth - left));
            height = Math.max(1, Math.min(height, imgHeight - top));
        } else {
            console.log('[ImageUtils] Invalid bbox format:', typeof bbox);
            return null;
        }

        // Validate final values
        if (isNaN(left) || isNaN(top) || isNaN(width) || isNaN(height)) {
            console.log('[ImageUtils] NaN values detected after processing:', { left, top, width, height });
            return null;
        }

        // Ensure integers
        left = Math.round(left);
        top = Math.round(top);
        width = Math.round(width);
        height = Math.round(height);

        console.log(`[ImageUtils] Cropping: left=${left}, top=${top}, width=${width}, height=${height}`);

        // Create output path
        const uploadsDir = path.resolve(__dirname, '../../uploads');
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }
        const outputFilename = `cropped_${Date.now()}.png`;
        const outputPath = path.join(uploadsDir, outputFilename);

        // Crop and enhance
        await image
            .extract({ left, top, width, height })
            .modulate({ brightness: 1.05 }) // Slight brightness boost
            .sharpen()
            .png({ quality: 90 })
            .toFile(outputPath);

        console.log(`[ImageUtils] Cropped image saved to: ${outputPath}`);
        return outputPath;
    } catch (error) {
        console.error('[ImageUtils] beautifyAndCrop error:', error.message);
        return null;
    }
}

/**
 * Convert image to base64 string
 * @param {string} imagePath - Path to the image
 * @returns {Promise<string|null>} - Base64 encoded string or null on failure
 */
export async function imageToBase64(imagePath) {
    try {
        const buffer = await sharp(imagePath).toBuffer();
        return buffer.toString('base64');
    } catch (error) {
        console.error('[ImageUtils] imageToBase64 error:', error.message);
        return null;
    }
}
