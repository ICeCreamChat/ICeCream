/**
 * ICeCream - Diagram Detector Service (Ported from MathSolver)
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 */
import fs from 'fs';
import { CONFIG } from './config.js';
import { parseWithMinerU, downloadAndExtractMineruImages } from './mineru.js';
import { canAttemptMineruDownload, getMineruDownloadAvailability } from './mineru-download.js';
import { detectWithQwenGrounding, detectWithFallbackAPI } from './siliconflow.js';
import { beautifyAndCrop, imageToBase64 } from './image-utils.js';

export async function convertCroppedDiagramToDataUrl(croppedPath, options = {}) {
    const cleanup = options.cleanup !== false;
    if (!croppedPath || typeof croppedPath !== 'string') return null;
    if (croppedPath.startsWith('data:image/')) return croppedPath;

    try {
        const base64 = await imageToBase64(croppedPath);
        return base64 ? `data:image/png;base64,${base64}` : null;
    } catch (error) {
        console.warn('[DiagramDetect] Failed to convert cropped diagram:', error.message);
        return null;
    } finally {
        if (cleanup) {
            try {
                if (fs.existsSync(croppedPath)) {
                    fs.unlinkSync(croppedPath);
                }
            } catch (error) {
                console.warn('[DiagramDetect] Failed to cleanup cropped diagram:', error.message);
            }
        }
    }
}

export async function detectAndCropDiagram(imagePath) {
    if (!CONFIG.siliconflow.apiKey) {
        console.log('[DiagramDetect] 跳过 - 无 API Key');
        return null;
    }

    try {
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

        console.log('[DiagramDetect] 开始检测...');

        // Layer 0: MinerU
        if (CONFIG.mineru.enabled && CONFIG.mineru.apiKey && canAttemptMineruDownload()) {
            console.log('[Layer 0] MinerU 云解析...');
            const mineruResult = await parseWithMinerU(imagePath);
            if (mineruResult && mineruResult.success && mineruResult.zipUrl) {
                const extractedImage = await downloadAndExtractMineruImages(mineruResult.zipUrl);
                if (extractedImage) {
                    console.log('[DiagramDetect] Layer 0 成功');
                    return extractedImage;
                }
            }
        } else if (CONFIG.mineru.enabled && CONFIG.mineru.apiKey) {
            const mineruStatus = getMineruDownloadAvailability();
            console.log(`[Layer 0] MinerU unavailable/cooldown, skip to Qwen Grounding. reason=${mineruStatus.reason || 'unknown'}`);
        }

        // Layer 1: Qwen Grounding
        let bbox = await detectWithQwenGrounding(imagePath);
        if (bbox) {
            console.log('[DiagramDetect] Layer 1 成功');
            const croppedPath = await beautifyAndCrop(imagePath, bbox);
            return await convertCroppedDiagramToDataUrl(croppedPath, { cleanup: true });
        }

        // Layer 4: Fallback API
        bbox = await detectWithFallbackAPI(imagePath, base64Image, mimeType);
        if (bbox) {
            console.log('[DiagramDetect] Layer 4 成功');
            const croppedPath = await beautifyAndCrop(imagePath, bbox);
            return await convertCroppedDiagramToDataUrl(croppedPath, { cleanup: true });
        }

        console.log('[DiagramDetect] 未检测到图形');
        return null;
    } catch (error) {
        console.error('[DiagramDetect Error]', error.message);
        return null;
    }
}
