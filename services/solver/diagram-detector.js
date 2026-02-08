/**
 * ICeCream - Diagram Detector Service (Ported from MathSolver)
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 */
import fs from 'fs';
import { CONFIG } from './config.js';
import { parseWithMinerU, downloadAndExtractMineruImages } from './mineru.js';
import { detectWithQwenGrounding, detectWithFallbackAPI } from './siliconflow.js';
import { beautifyAndCrop } from './image-utils.js';

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
        if (CONFIG.mineru.enabled && CONFIG.mineru.apiKey) {
            console.log('[Layer 0] MinerU 云解析...');
            const mineruResult = await parseWithMinerU(imagePath);
            if (mineruResult && mineruResult.success && mineruResult.zipUrl) {
                const extractedImage = await downloadAndExtractMineruImages(mineruResult.zipUrl);
                if (extractedImage) {
                    console.log('[DiagramDetect] Layer 0 成功');
                    return extractedImage;
                }
            }
        }

        // Layer 1: Qwen Grounding
        let bbox = await detectWithQwenGrounding(imagePath);
        if (bbox) {
            console.log('[DiagramDetect] Layer 1 成功');
            return await beautifyAndCrop(imagePath, bbox);
        }

        // Layer 4: Fallback API
        bbox = await detectWithFallbackAPI(imagePath, base64Image, mimeType);
        if (bbox) {
            console.log('[DiagramDetect] Layer 4 成功');
            return await beautifyAndCrop(imagePath, bbox);
        }

        console.log('[DiagramDetect] 未检测到图形');
        return null;
    } catch (error) {
        console.error('[DiagramDetect Error]', error.message);
        return null;
    }
}
