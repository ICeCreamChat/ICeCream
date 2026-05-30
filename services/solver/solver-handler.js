/**
 * ICeCream Solver Handler Service
 * Complete port from MathSolver
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

import { isMockMode } from './config.js';
import { describeImageWithVision, extractTextWithVisionOCR } from './siliconflow.js';
import { solveWithDeepSeek, chatWithDeepSeek } from './deepseek.js';
import { detectAndCropDiagram } from './diagram-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8;

/**
 * Main solver endpoint handler
 */
export async function handleSolve(req, res) {
    const startTime = Date.now();
    let imagePath = null;
    let shouldCleanup = false;

    try {
        const { message, imageBase64 } = req.body;
        const imageFile = req.file;

        if (imageBase64) {
            const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '').replace(/\s/g, '');
            if (base64Data.length > MAX_BASE64_CHARS) {
                return res.status(400).json({
                    success: false,
                    error: '图片过大，请压缩后重试（最大 20MB）'
                });
            }

            const buffer = Buffer.from(base64Data, 'base64');
            if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
                return res.status(400).json({
                    success: false,
                    error: '图片过大，请压缩后重试（最大 20MB）'
                });
            }

            try {
                await sharp(buffer).metadata();
            } catch {
                return res.status(400).json({
                    success: false,
                    error: '无法识别的图片格式'
                });
            }

            const uploadDir = path.join(__dirname, '../../uploads');
            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
            imagePath = path.join(uploadDir, `${Date.now()}.png`);
            fs.writeFileSync(imagePath, buffer);
            shouldCleanup = true;
        } else if (imageFile) {
            imagePath = imageFile.path;
            shouldCleanup = true;
        } else if (!message) {
            return res.status(400).json({
                success: false,
                error: '请上传题目图片或输入题目内容'
            });
        }

        console.log(`\n=== ICeCream Solver Request [${new Date().toLocaleString()}] ===`);
        console.log(`Mode: ${isMockMode() ? 'MOCK' : 'PROD'}`);

        let visionResult = { description: '' };
        let ocrResult = { text: message || '', success: true };
        let diagramBase64 = null;

        if (imagePath) {
            // Step 1: Vision Description -> OCR (sequential; OCR depends on vision description)
            console.log('-> Vision & OCR');
            visionResult = await describeImageWithVision(imagePath);
            ocrResult = await extractTextWithVisionOCR(imagePath, visionResult.description || '');

            // Step 2: DeepSeek & Diagram Detection (parallel)
            console.log('-> DeepSeek & Diagram');
            const [deepseekResult, diagram] = await Promise.all([
                solveWithDeepSeek(ocrResult.text || '', visionResult.description || ''),
                detectAndCropDiagram(imagePath)
            ]);

            diagramBase64 = diagram;

            if (shouldCleanup && fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }

            const totalTime = Date.now() - startTime;
            console.log(`=== DONE (${totalTime}ms) ===\n`);

            return res.json({
                success: true,
                intent: 'solver',
                isMockMode: isMockMode(),
                timing: { total: totalTime },
                data: {
                    extractedText: ocrResult.text || '',
                    imageDescription: visionResult.description || '',
                    diagramBase64: diagramBase64 || null,
                    solution: deepseekResult.answer || '',
                    solverMeta: deepseekResult.solverMeta || null
                }
            });
        }

        console.log('-> DeepSeek (Text Only)');
        const deepseekResult = await solveWithDeepSeek(message, '');

        const totalTime = Date.now() - startTime;
        console.log(`=== DONE (${totalTime}ms) ===\n`);

        return res.json({
            success: true,
            intent: 'solver',
            isMockMode: isMockMode(),
            timing: { total: totalTime },
            data: {
                extractedText: message,
                imageDescription: null,
                diagramBase64: null,
                solution: deepseekResult.answer || '',
                solverMeta: deepseekResult.solverMeta || null
            }
        });
    } catch (error) {
        console.error('[Solver Handler] Error:', error);

        if (shouldCleanup && imagePath && fs.existsSync(imagePath)) {
            try { fs.unlinkSync(imagePath); } catch { }
        }

        return res.status(500).json({
            success: false,
            error: error.message || 'Server Error'
        });
    }
}

/**
 * Follow-up QA handler
 */
export async function handleFollowUp(req, res) {
    try {
        const { message, context } = req.body;

        if (!message) {
            return res.status(400).json({
                success: false,
                error: '问题不能为空'
            });
        }

        const systemPrompt = `你是一个数学老师，正在帮助学生解答问题。\n之前的题目上下文：${context || '无'}\n\n请针对学生的追问给出解答。使用 LaTeX 格式书写数学公式。`;

        const responseData = await chatWithDeepSeek([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message }
        ], null, 0.5);

        const reply = responseData.choices?.[0]?.message?.content || '';

        return res.json({
            success: true,
            data: { reply }
        });
    } catch (error) {
        console.error('[Solver Handler] Follow-up Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
}

export default { handleSolve, handleFollowUp };
