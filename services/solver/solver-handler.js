/**
 * ICeCream Solver Handler Service
 * Complete port from MathSolver
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 * 
 * 双引擎架构:
 * Engine A (Vision): Qwen2.5-VL - 视觉感知 + OCR
 * Engine B (Reasoning): DeepSeek V3 - 逻辑推理
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

// Import ported services
import { CONFIG, isMockMode } from './config.js';
import { describeImageWithVision, extractTextWithVisionOCR } from './siliconflow.js';
import { solveWithDeepSeek, chatWithDeepSeek } from './deepseek.js';
import { detectAndCropDiagram } from './diagram-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 主解题端点处理器
 */
export async function handleSolve(req, res) {
    const startTime = Date.now();
    let imagePath = null;
    let shouldCleanup = false;

    try {
        const { message, imageBase64 } = req.body;
        const imageFile = req.file;

        // Handle image input
        if (imageBase64) {
            // Base64 上传
            const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            const uploadDir = path.join(__dirname, '../../uploads');
            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
            imagePath = path.join(uploadDir, `${Date.now()}.png`);
            fs.writeFileSync(imagePath, buffer);
            shouldCleanup = true;
        } else if (imageFile) {
            // 文件上传
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

        // 如果有图片，执行完整的视觉处理流程
        if (imagePath) {
            // Step 1: Vision Description & OCR (并行执行)
            console.log('-> Vision & OCR');
            visionResult = await describeImageWithVision(imagePath);
            ocrResult = await extractTextWithVisionOCR(imagePath, visionResult.description || '');

            // Step 2: DeepSeek & Diagram Detection (并行执行)
            console.log('-> DeepSeek & Diagram');
            const [deepseekResult, diagram] = await Promise.all([
                solveWithDeepSeek(ocrResult.text || '', visionResult.description || ''),
                detectAndCropDiagram(imagePath)
            ]);

            diagramBase64 = diagram;

            // Cleanup
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
                    solution: deepseekResult.answer || ''
                }
            });
        } else {
            // 纯文本输入，只调用 DeepSeek
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
                    solution: deepseekResult.answer || ''
                }
            });
        }

    } catch (error) {
        console.error('[Solver Handler] Error:', error);

        // Cleanup on error
        if (shouldCleanup && imagePath && fs.existsSync(imagePath)) {
            try { fs.unlinkSync(imagePath); } catch (e) { }
        }

        return res.status(500).json({
            success: false,
            error: error.message || 'Server Error'
        });
    }
}

/**
 * 处理追问请求
 */
/**
 * 处理追问请求
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

        // 构造 System Prompt，注入上下文
        const systemPrompt = `你是一个数学老师，正在帮助学生解答问题。
之前的题目上下文：
${context || '无'}

请针对学生的追问给出解答。使用 LaTeX 格式书写数学公式。`;

        // ✨ 重构：直接调用封装好的 chatWithDeepSeek
        // 参数: (messages, model=null, temperature=0.5)
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
