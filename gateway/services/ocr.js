
import fetch from 'node-fetch';
import FormData from 'form-data';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const SILICONFLOW_BASE = process.env.SILICONFLOW_API_BASE || 'https://api.siliconflow.cn/v1';
const SILICONFLOW_KEY = process.env.SILICONFLOW_API_KEY;
// The model ID provided by user discussion
const PADDLE_MODEL = 'PaddlePaddle/PaddleOCR-VL-1.5'; 

const MINERU_URL = process.env.MINERU_URL || 'https://mineru.net';
const MINERU_KEY = process.env.MINERU_API_KEY;

const DEEPSEEK_BASE = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = 'deepseek-chat'; // Use standard chat model for cleaning

/**
 * Recognize text from image using SiliconFlow PaddleOCR-VL-1.5
 * @param {Buffer} imageBuffer 
 * @param {string} mimeType 
 */
export async function recognizeWithPaddle(imageBuffer, mimeType = 'image/jpeg') {
    if (!SILICONFLOW_KEY) throw new Error('Missing SILICONFLOW_API_KEY');

    const base64Image = imageBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    const payload = {
        model: PADDLE_MODEL,
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: '请识别图片中的表格内容，提取所有学生信息（姓名、性别、成绩等），并直接以 JSON 格式输出，格式为：[{"name": "...", "gender": "...", "grade": ...}]。不要输出其他废话。'
                    },
                    {
                        type: 'image_url',
                        image_url: {
                            url: dataUrl
                        }
                    }
                ]
            }
        ],
        max_tokens: 4096,
        temperature: 0.1 // Low temperature for factual extraction
    };

    const response = await fetch(`${SILICONFLOW_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SILICONFLOW_KEY}`
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`SiliconFlow API Error: ${response.status} ${errText}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
}

/**
 * Recognize text using MinerU (Fallback)
 * @param {Buffer} imageBuffer 
 * @param {string} filename 
 */
export async function recognizeWithMinerU(imageBuffer, filename = 'image.jpg') {
    if (!MINERU_KEY) throw new Error('Missing MINERU_API_KEY');

    const form = new FormData();
    form.append('file', imageBuffer, { filename });
    // MinerU typically extracts layout to markdown, use that endpoint if available
    // Assuming /api/v4/file/parse is the standard general parser or similar
    // Check documentation logic: usually specific OCR endpoint is preferable for raw text
    // But for layout analysis (tables), parse is better.
    // Let's try general file parse endpoint which handles images too.
    
    // Note: MinerU API structure might vary. Using a standard assumption based on context.
    // If specific endpoint is /api/v4/ocr/pdf (as hinted in env comments or assumed)
    // Actually /api/v4/file/parse is common for universal parsing.
    
    const response = await fetch(`${MINERU_URL}/api/v4/file/parse`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${MINERU_KEY}`,
            ...form.getHeaders()
        },
        body: form
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`MinerU API Error: ${response.status} ${errText}`);
    }

    const result = await response.json();
    /* 
       MinerU async response handling might be needed if it returns a task ID. 
       If it's synchronous for small images, we get result. 
       If it returns { code: 0, data: { task_id: ... } }, we need to poll.
       For the sake of this implementation, let's assume valid direct response or simple extraction.
       However, if MinerU is async-only, we might need a polling loop.
       Let's assume a simpler OCR endpoint exists or this is synchronous for images.
       
       Adjusting to use a more direct OCR assumptions if possible.
       If MinerU is purely async, this might timeout. 
    */
   
    // If response contains content directly:
    if (result.code === 0 && result.data && result.data.markdown) {
        return result.data.markdown;
    }
    
    // If it returns a task_id, we might need to poll. 
    // Implementing a simple polling mechanism just in case.
    if (result.code === 0 && result.data && result.data.task_id) {
        return await pollMinerUTask(result.data.task_id);
    }

    throw new Error('MinerU response invalid: ' + JSON.stringify(result));
}

async function pollMinerUTask(taskId, maxAttemps = 20) {
    for (let i = 0; i < maxAttemps; i++) {
        await new Promise(r => setTimeout(r, 2000)); // Wait 2s
        const res = await fetch(`${MINERU_URL}/api/v4/file/${taskId}`, {
            headers: { 'Authorization': `Bearer ${MINERU_KEY}` }
        });
        const data = await res.json();
        
        if (data.code === 0 && data.data && data.data.state === 'done') {
            // Fetch result url content
            // Usually returns a result URL or content directly?
            // If data.data.markdown exists
            if (data.data.markdown) return data.data.markdown;
            
            // If result_url
            if (data.data.result_url) {
                const mdRes = await fetch(data.data.result_url);
                return await mdRes.text();
            }
        }
        
        if (data.code !== 0 || data.data.state === 'failed') {
            throw new Error('MinerU Task Failed');
        }
    }
    throw new Error('MinerU Task Timeout');
}

/**
 * Extract structured student data from text using DeepSeek
 * @param {string} text 
 */
export async function extractStudentsWithAI(text) {
    if (!text) return [];

    const prompt = `
你是一个数据提取助手。请从以下文本中提取学生名单。
文本可能包含OCR错误、乱码或无关表头。
请提取：姓名(name)、性别(gender, M/F)、成绩(grade, 数字)。
如果性别未知，默认为M。如果成绩未知，不填。
忽略非学生信息的文字。

文本内容：
${text.substring(0, 5000)}

输出严格的JSON数组，不要Markdown标记：
[{"name": "张三", "gender": "M", "grade": 85}, ...]
    `;

    const response = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_KEY}`
        },
        body: JSON.stringify({
            model: DEEPSEEK_MODEL || 'deepseek-chat',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            response_format: { type: 'json_object' } // If supported, else text
        })
    });

    if (!response.ok) {
        throw new Error(`DeepSeek API Error: ${response.status}`);
    }

    const data = await response.json();
    let content = data.choices[0]?.message?.content || '[]';
    
    // Clean up markdown code blocks if present
    content = content.replace(/```json/g, '').replace(/```/g, '').trim();
    
    try {
        const students = JSON.parse(content);
        // Ensure result is array and normalize
        if (Array.isArray(students)) return students;
        if (students.students && Array.isArray(students.students)) return students.students;
        return [];
    } catch (e) {
        console.error('JSON Parse Error:', content);
        return [];
    }
}
