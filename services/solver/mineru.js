/**
 * ICeCream Solver - MinerU Cloud Integration
 * Ported from MathSolver
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 */

import fetch from 'node-fetch';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function downloadAndExtractMineruImages(zipUrl) {
    console.log('[MinerU] 下载并提取图片...');
    try {
        const response = await fetch(zipUrl);
        if (!response.ok) {
            console.log('[MinerU] 下载 zip 失败:', response.status);
            return null;
        }

        // Dynamic import for adm-zip (optional dependency)
        let AdmZip;
        try {
            AdmZip = (await import('adm-zip')).default;
        } catch (e) {
            console.log('[MinerU] adm-zip 未安装，跳过 zip 解析');
            return null;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries();

        for (const entry of entries) {
            const name = entry.entryName.toLowerCase();
            if (name.includes('images/') && (name.endsWith('.jpg') || name.endsWith('.png') || name.endsWith('.jpeg'))) {
                console.log('[MinerU] 找到图片:', entry.entryName);
                const imageBuffer = entry.getData();

                // Simple processing: flatten background to white + normalize
                const processedBuffer = await sharp(imageBuffer)
                    .flatten({ background: { r: 255, g: 255, b: 255 } })
                    .normalize()
                    .png()
                    .toBuffer();

                const base64 = processedBuffer.toString('base64');
                return `data:image/png;base64,${base64}`;
            }
        }

        console.log('[MinerU] zip 中未找到图片');
        return null;
    } catch (e) {
        console.log('[MinerU] 提取图片失败:', e.message);
        return null;
    }
}

export async function parseWithMinerU(imagePath) {
    if (!CONFIG.mineru.enabled || !CONFIG.mineru.apiKey) {
        return null;
    }

    console.log('[MinerU Cloud] 开始解析...');
    const baseUrl = CONFIG.mineru.url;
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.mineru.apiKey}`
    };

    try {
        // Step 1: Get Upload Link
        const fileName = path.basename(imagePath);
        const batchRes = await fetch(`${baseUrl}/api/v4/file-urls/batch`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                files: [{ name: fileName }],
                model_version: 'vlm',
                enable_formula: true,
                enable_table: true
            })
        });

        if (!batchRes.ok) return null;
        const batchData = await batchRes.json();
        if (batchData.code !== 0) return null;

        const batchId = batchData.data.batch_id;
        const uploadUrl = batchData.data.file_urls[0];
        console.log('[MinerU Cloud] Batch ID:', batchId);

        // Step 2: Upload File
        const fileBuffer = fs.readFileSync(imagePath);
        let uploadRes;
        let uploadAttempts = 0;
        const maxUploadAttempts = 6;

        while (uploadAttempts < maxUploadAttempts) {
            try {
                uploadRes = await fetch(uploadUrl, {
                    method: 'PUT',
                    body: fileBuffer
                });

                if (uploadRes.ok) break;
                console.log(`[MinerU Cloud] 上传失败 (尝试 ${uploadAttempts + 1}/${maxUploadAttempts}): ${uploadRes.status}`);
            } catch (err) {
                console.log(`[MinerU Cloud] 上传网络错误 (尝试 ${uploadAttempts + 1}/${maxUploadAttempts}): ${err.message}`);
            }

            uploadAttempts++;
            if (uploadAttempts < maxUploadAttempts) {
                await delay(1000);
            }
        }

        if (!uploadRes || !uploadRes.ok) return null;

        // Step 3: Poll Results
        const maxWait = 60000;
        const pollInterval = 3000;
        let waited = 0;

        while (waited < maxWait) {
            await delay(pollInterval);
            waited += pollInterval;

            const resultRes = await fetch(`${baseUrl}/api/v4/extract-results/batch/${batchId}`, {
                method: 'GET',
                headers
            });

            if (!resultRes.ok) continue;

            const resultData = await resultRes.json();
            if (resultData.code !== 0) continue;

            const extractResult = resultData.data?.extract_result?.[0];
            if (!extractResult) continue;

            if (extractResult.state === 'done') {
                return {
                    success: true,
                    zipUrl: extractResult.full_zip_url,
                    state: 'done'
                };
            } else if (extractResult.state === 'failed') {
                console.log('[MinerU Cloud] 解析失败:', extractResult.err_msg);
                return null;
            }
        }
        return null;

    } catch (e) {
        console.warn(`[MinerU Cloud] Error: ${e.message}`);
        return null;
    }
}

export default { parseWithMinerU, downloadAndExtractMineruImages };
