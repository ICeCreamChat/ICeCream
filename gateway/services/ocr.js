
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import os from 'os';

dotenv.config();

const SILICONFLOW_BASE = process.env.SILICONFLOW_API_BASE || 'https://api.siliconflow.cn/v1';
const SILICONFLOW_KEY = process.env.SILICONFLOW_API_KEY;
// Use the same VLM model that the Solver uses successfully for vision tasks
const VLM_MODEL = 'Qwen/Qwen2.5-VL-72B-Instruct';

const MINERU_URL = process.env.MINERU_URL || 'https://mineru.net';
const MINERU_KEY = process.env.MINERU_API_KEY;
const MINERU_ENABLED = process.env.MINERU_ENABLED === 'true';

const DEEPSEEK_BASE = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = 'deepseek-chat';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * [PRIMARY] Extract students directly from image using VLM in one shot.
 * Sends image to Qwen2.5-VL and asks for structured JSON output.
 * This avoids the lossy OCR→text→AI two-step pipeline.
 * @param {Buffer} imageBuffer * @param {string} mimeType * @returns {Array} Array of student objects {name, gender, grade}
 */
export async function extractStudentsDirectVLM(imageBuffer, mimeType = 'image/jpeg') {
    if (!SILICONFLOW_KEY) throw new Error('Missing SILICONFLOW_API_KEY');

    const base64Image = imageBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    const prompt = `请仔细观察图片中的学生名单表格，提取每一位学生的信息。

要求：
1. 提取所有列（图片可能有多列并排的表格）
2. 每个学生包含：姓名(name)、性别(gender)、成绩(grade)
3. 性别请输出 "M"（男）或 "F"（女）
4. 成绩为数字，如果看不清就填 null
5. 注意区分性别：根据文字"男""女"判断，不要猜测
6. 不要遗漏任何学生，包括图片边缘的

直接输出JSON数组，不要任何其他文字或Markdown标记：
[{"name":"张三","gender":"M","grade":85},{"name":"李四","gender":"F","grade":90}]`;

    const payload = {
        model: VLM_MODEL,
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'image_url',
                        image_url: { url: dataUrl }
                    },
                    {
                        type: 'text',
                        text: prompt
                    }
                ]
            }
        ],
        max_tokens: 8192,
        temperature: 0.05
    };

    const response = await fetch(`${SILICONFLOW_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SILICONFLOW_KEY}`
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120000) // 120s timeout
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`SiliconFlow VLM Error: ${response.status} ${errText}`);
    }

    const data = await response.json();
    let content = data.choices[0]?.message?.content || '[]';
    // Clean up markdown code blocks if present
    content = content.replace(/```json/g, '').replace(/```/g, '').trim();
    const students = JSON.parse(content);
    if (Array.isArray(students)) return students;
    if (students.students && Array.isArray(students.students)) return students.students;
    throw new Error('VLM did not return a valid array');
}

/**
 * [FALLBACK] Recognize text from image using SiliconFlow VLM (Qwen2.5-VL)
 * Returns raw OCR text for further processing by DeepSeek.
 * @param {Buffer} imageBuffer * @param {string} mimeType */
export async function recognizeWithPaddle(imageBuffer, mimeType = 'image/jpeg') {
    if (!SILICONFLOW_KEY) throw new Error('Missing SILICONFLOW_API_KEY');

    const base64Image = imageBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    const payload = {
        model: VLM_MODEL,
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'image_url',
                        image_url: { url: dataUrl }
                    },
                    {
                        type: 'text',
                        text: '请识别图片中的所有文字内容，包括表格。如果有表格，请用Markdown表格格式输出。直接输出识别到的文字，不要添加额外说明。'
                    }
                ]
            }
        ],
        max_tokens: 4096,
        temperature: 0.1
    };

    const response = await fetch(`${SILICONFLOW_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SILICONFLOW_KEY}`
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120000) // 120s timeout
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`SiliconFlow API Error: ${response.status} ${errText}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
}

/**
 * Recognize text using MinerU Cloud (3-step async flow)
 * Matches the working Solver implementation:
 * 1. POST /api/v4/file-urls/batch -> get upload URL + batch_id
 * 2. PUT file to upload URL
 * 3. Poll GET /api/v4/extract-results/batch/{batch_id}
 * @param {Buffer} imageBuffer * @param {string} filename */
export async function recognizeWithMinerU(imageBuffer, filename = 'image.png') {
    if (!MINERU_KEY) throw new Error('Missing MINERU_API_KEY');
    if (!MINERU_ENABLED) throw new Error('MinerU is disabled');

    const baseUrl = MINERU_URL;
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MINERU_KEY}`
    };

    // Step 1: Get Upload Link
    console.log('[MinerU OCR] Step 1: Getting upload URL...');
    const batchRes = await fetch(`${baseUrl}/api/v4/file-urls/batch`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            files: [{ name: filename }],
            enable_formula: false,
            enable_table: true
        })
    });

    if (!batchRes.ok) {
        const errText = await batchRes.text();
        throw new Error(`MinerU batch API Error: ${batchRes.status} ${errText}`);
    }

    const batchData = await batchRes.json();
    if (batchData.code !== 0) {
        throw new Error(`MinerU batch error: ${JSON.stringify(batchData)}`);
    }

    const batchId = batchData.data.batch_id;
    const uploadUrl = batchData.data.file_urls[0];
    console.log('[MinerU OCR] Step 1 done. Batch ID:', batchId);

    // Step 2: Upload File
    console.log('[MinerU OCR] Step 2: Uploading file...');
    let uploadRes;
    let uploadAttempts = 0;
    const maxUploadAttempts = 3;

    while (uploadAttempts < maxUploadAttempts) {
        try {
            uploadRes = await fetch(uploadUrl, {
                method: 'PUT',
                body: imageBuffer
            });

            if (uploadRes.ok) break;
            console.log(`[MinerU OCR] Upload failed (attempt ${uploadAttempts + 1}/${maxUploadAttempts}): ${uploadRes.status}`);
        } catch (err) {
            console.log(`[MinerU OCR] Upload network error (attempt ${uploadAttempts + 1}/${maxUploadAttempts}): ${err.message}`);
        }

        uploadAttempts++;
        if (uploadAttempts < maxUploadAttempts) {
            await delay(1000);
        }
    }

    if (!uploadRes || !uploadRes.ok) {
        throw new Error('MinerU file upload failed after retries');
    }
    console.log('[MinerU OCR] Step 2 done. File uploaded.');

    // Step 3: Poll Results
    console.log('[MinerU OCR] Step 3: Polling for results...');
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
            console.log('[MinerU OCR] Step 3 done. Extraction complete.');
            // Try to get markdown content from the full_zip_url
            if (extractResult.full_zip_url) {
                try {
                    // Download and extract markdown from zip
                    let AdmZip;
                    try {
                        AdmZip = (await import('adm-zip')).default;
                    } catch (e) {
                        console.log('[MinerU OCR] adm-zip not available, trying markdown URL');
                        // Fallback: try markdown_url if available
                        if (extractResult.markdown_url) {
                            const mdRes = await fetch(extractResult.markdown_url);
                            return await mdRes.text();
                        }
                        return '[MinerU extraction done but cannot parse zip]';
                    }

                    const zipRes = await fetch(extractResult.full_zip_url);
                    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
                    const zip = new AdmZip(zipBuffer);
                    const entries = zip.getEntries();
                    // Find markdown file in zip
                    for (const entry of entries) {
                        if (entry.entryName.endsWith('.md')) {
                            return entry.getData().toString('utf8');
                        }
                    }
                } catch (e) {
                    console.warn('[MinerU OCR] Failed to extract zip:', e.message);
                }
            }
            return '[MinerU extraction done]';
        } else if (extractResult.state === 'failed') {
            throw new Error(`MinerU extraction failed: ${extractResult.err_msg || 'unknown'}`);
        }

        console.log(`[MinerU OCR] Polling... (${waited / 1000}s elapsed, state: ${extractResult.state || 'pending'})`);
    }

    throw new Error('MinerU extraction timeout (60s)');
}

/**
 * Extract structured student data from text using DeepSeek
 * @param {string} text */
export async function extractStudentsWithAI(text) {
    if (!text) return [];

    const prompt = `
你是一个数据提取助手。请从以下文本中提取学生名单。
文本可能包含OCR错误、乱码或无关表头。
请提取：姓名(name)、性别(gender, M/F)、成绩(grade, 数字)。
如果性别不确定，根据中文名字推测（常见男名/女名）。
如果成绩未知，不填。
忽略非学生信息的文字。

文本内容：
${text.substring(0, 5000)}

输出严格的JSON对象，不要Markdown标记：
{"students": [{"name": "张三", "gender": "M", "grade": 85}, ...]}
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
            response_format: { type: 'json_object' }
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
