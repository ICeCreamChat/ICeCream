/**
 * ICeCream - SiliconFlow Service (Ported from MathSolver)
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 */
import fetch from 'node-fetch';
import sharp from 'sharp';
import fs from 'fs';
import { CONFIG, MOCK_DATA } from './config.js';

const GROUNDING_PROMPT = `这是中文试卷或教辅资料的截图。请精确检测其中的插图、示意图或几何图形区域。

规则：
1. 目标是提取题目中的辅助图形（如几何图、函数图、物理模型图等）
2. 即使图形很小（如嵌入在文字中的皮带轮、滑块），也要精确检测
3. **严格排除**：不要框选**表格(Table)**、单纯的文字块、公式块。如果图中只有表格，请返回 null。
4. 只框选图形本身，**不要**包含周围的题号、选项文字或说明文字
5. 边界框要紧贴图形边缘，不要留太多空白

输出格式（严格JSON）:
{"bbox_2d": [x1, y1, x2, y2]}

x1,y1 是左上角像素坐标，x2,y2 是右下角像素坐标。
如果没有图形，返回: {"bbox_2d": null}`;

const FALLBACK_PROMPT = `这是一道数学题的图片。请找出图中的几何图形（如三角形、正方形、圆等）。

返回图形所在区域的边界框，格式：
{"box": [左边界百分比, 上边界百分比, 右边界百分比, 下边界百分比]}

百分比范围 0-100。例如图形在右半部分：{"box": [50, 20, 95, 80]}`;

const VISION_PROMPT = `请仔细观察图片，忽略所有文字内容，仅详细描述图中的几何图形、坐标系、函数图像或其他数学图形。

描述要求：
1. 几何图形：描述形状、位置关系、标记的点和线段、辅助线
2. 坐标系：描述坐标轴、原点、函数曲线的走势和关键点
3. 辅助线：特别指出虚线、辅助构造
4. 角度和平行/垂直关系

输出格式：纯文本描述，不要使用Markdown格式。`;

// Content Type Hints
const CONTENT_HINTS = {
    '波形': '波形曲线和坐标刻度由系统单独处理',
    '正弦': '正弦/余弦曲线由系统单独处理',
    '几何': '几何图形由系统单独处理',
    '三角': '三角形图形由系统单独处理',
    '坐标': '坐标系图形由系统单独处理',
    '函数': '函数图像由系统单独处理',
    '圆': '圆形图形由系统单独处理',
    '抛物线': '抛物线图形由系统单独处理'
};


export async function detectWithQwenGrounding(imagePath) {
    console.log('[Layer 1] Qwen Grounding 检测...');
    try {
        const metadata = await sharp(imagePath).metadata();
        const origWidth = metadata.width;
        const origHeight = metadata.height;

        const TARGET_SIZE = 1000;
        const resizedBuffer = await sharp(imagePath)
            .resize(TARGET_SIZE, TARGET_SIZE, { fit: 'fill' })
            .png()
            .toBuffer();
        const resizedBase64 = resizedBuffer.toString('base64');

        const response = await fetch(CONFIG.siliconflow.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.siliconflow.apiKey}`
            },
            body: JSON.stringify({
                model: CONFIG.siliconflow.model,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${resizedBase64}` } },
                        { type: 'text', text: GROUNDING_PROMPT }
                    ]
                }],
                max_tokens: 150,
                temperature: 0.05
            })
        });

        if (!response.ok) return null;

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';

        const match = content.match(/\{[\s\S]*"bbox_2d"[\s\S]*\}/);
        if (!match) return null;

        const parsed = JSON.parse(match[0]);
        if (!parsed.bbox_2d || !Array.isArray(parsed.bbox_2d)) return null;

        const [x1, y1, x2, y2] = parsed.bbox_2d;
        if (x2 > x1 && y2 > y1) {
            const scaleX = origWidth / TARGET_SIZE;
            const scaleY = origHeight / TARGET_SIZE;
            return [
                Math.round(x1 * scaleX),
                Math.round(y1 * scaleY),
                Math.round(x2 * scaleX),
                Math.round(y2 * scaleY)
            ];
        }
        return null;
    } catch (e) {
        console.log('[Layer 1] 失败:', e.message);
        return null;
    }
}

export async function detectWithFallbackAPI(imagePath, base64Image, mimeType) {
    console.log('[Layer 4] 兜底 API 检测...');
    try {
        const response = await fetch(CONFIG.siliconflow.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.siliconflow.apiKey}`
            },
            body: JSON.stringify({
                model: CONFIG.siliconflow.model,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
                        { type: 'text', text: FALLBACK_PROMPT }
                    ]
                }],
                max_tokens: 100,
                temperature: 0.1
            })
        });

        if (!response.ok) return null;
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';
        const match = content.match(/\{[\s\S]*"box"[\s\S]*\}/);
        if (!match) return null;

        const parsed = JSON.parse(match[0]);
        if (!parsed.box || parsed.box.length !== 4) return null;

        const [left, top, right, bottom] = parsed.box.map(v => Math.max(0, Math.min(100, Number(v) || 0)));
        if (right > left && bottom > top) {
            return [left, top, right, bottom];
        }
        return null;
    } catch (e) {
        console.log('[Layer 4] 失败:', e.message);
        return null;
    }
}

export async function describeImageWithVision(imagePath) {
    if (!CONFIG.siliconflow.apiKey) {
        return MOCK_DATA.siliconflow;
    }

    try {
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

        const response = await fetch(CONFIG.siliconflow.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.siliconflow.apiKey}`
            },
            body: JSON.stringify({
                model: CONFIG.siliconflow.model,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
                        { type: 'text', text: VISION_PROMPT }
                    ]
                }],
                max_tokens: 500,
                temperature: 0.3
            })
        });

        if (!response.ok) return MOCK_DATA.siliconflow;
        const data = await response.json();
        return { description: data.choices?.[0]?.message?.content || '' };
    } catch (error) {
        return MOCK_DATA.siliconflow;
    }
}

function buildAdaptiveOCRPrompt(visionDescription = '') {
    let hint = '图形内容由系统单独处理';
    for (const [keyword, hintText] of Object.entries(CONTENT_HINTS)) {
        if (visionDescription.includes(keyword)) {
            hint = hintText;
            break;
        }
    }
    return `请提取图片中的文字内容。

上下文: ${hint}，你只需提取纯文字（题目、选项、说明等）。

格式要求:
- 数学公式用 $...$ 包裹
- 保持选项格式（A. B. C.）
- **表格必须使用 Markdown 格式** (即使用 | 分隔符)
- 不要描述或表示图形

直接输出文字内容:`;
}

export async function extractTextWithVisionOCR(imagePath, visionDescription = '') {
    if (!CONFIG.siliconflow.apiKey) {
        return MOCK_DATA.mineru;
    }

    try {
        const prompt = buildAdaptiveOCRPrompt(visionDescription);
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

        const response = await fetch(CONFIG.siliconflow.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.siliconflow.apiKey}`
            },
            body: JSON.stringify({
                model: CONFIG.siliconflow.model,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
                        { type: 'text', text: prompt }
                    ]
                }],
                max_tokens: 1500,
                temperature: 0.1
            })
        });

        if (!response.ok) return MOCK_DATA.mineru;
        const data = await response.json();
        return {
            success: true,
            text: data.choices?.[0]?.message?.content || '',
            latex: ''
        };
    } catch (error) {
        return {
            success: false,
            text: '[OCR 失败] 无法识别图片中的文字',
            latex: ''
        };
    }
}
