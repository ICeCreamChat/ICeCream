
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import {
    canAttemptMineruDownload,
    fetchMineruZipWithRetry,
    getMineruDownloadAvailability,
} from '../../services/solver/mineru-download.js';
import {
    fetchJsonWithTimeout,
    fetchTextWithTimeout,
    fetchWithBudget,
    readProviderTimeoutMs,
} from '../../services/provider-fetch.js';

dotenv.config();

const SILICONFLOW_BASE = process.env.SILICONFLOW_API_BASE || 'https://api.siliconflow.cn/v1';
const SILICONFLOW_KEY = process.env.SILICONFLOW_API_KEY;
// VLM model configurable via .env (default: Qwen2.5-VL-72B)
const VLM_MODEL = process.env.SILICONFLOW_VLM_MODEL || 'Qwen/Qwen2.5-VL-72B-Instruct';

const MINERU_URL = process.env.MINERU_URL || 'https://mineru.net';
const MINERU_KEY = process.env.MINERU_API_KEY;
const MINERU_ENABLED = process.env.MINERU_ENABLED === 'true';

const DEEPSEEK_BASE = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = 'deepseek-chat';
const OCR_PROVIDER_TIMEOUT_MS = readProviderTimeoutMs(
    process.env.OCR_PROVIDER_TIMEOUT_MS || process.env.PROVIDER_FETCH_TIMEOUT_MS,
    120000
);
const MINERU_API_TIMEOUT_MS = readProviderTimeoutMs(
    process.env.MINERU_API_TIMEOUT_MS || process.env.PROVIDER_FETCH_TIMEOUT_MS,
    60000
);
const DEEPSEEK_PROVIDER_TIMEOUT_MS = readProviderTimeoutMs(
    process.env.DEEPSEEK_PROVIDER_TIMEOUT_MS || process.env.PROVIDER_FETCH_TIMEOUT_MS,
    60000
);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * [PRIMARY] Extract students directly from image using VLM in one shot.
 * Sends image to Qwen2.5-VL and asks for structured JSON output.
 * This avoids the lossy OCR→text→AI two-step pipeline.
 * @param {Buffer} imageBuffer * @param {string} mimeType * @returns {Array} Array of student objects {name, gender, height, grade}
 */
export async function extractStudentsDirectVLM(imageBuffer, mimeType = 'image/jpeg') {
    if (!SILICONFLOW_KEY) throw new Error('Missing SILICONFLOW_API_KEY');

    const base64Image = imageBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    const prompt = `请仔细观察图片中的学生名单表格，提取每一位学生的信息。

要求：
1. 提取所有列（图片可能有多列并排的表格）
2. 每个学生包含：姓名(name)、性别(gender)、身高(height)、成绩(grade)
3. 性别请输出 "M"（男）或 "F"（女）
4. 身高为数字（厘米），如果身高看不清就填 null
5. 成绩为数字，如果看不清就填 null
6. 注意区分性别：根据文字"男""女"判断，不要猜测
7. 不要遗漏任何学生，包括图片边缘的

直接输出JSON数组，不要任何其他文字或Markdown标记：
[{"name":"张三","gender":"M","height":170,"grade":85},{"name":"李四","gender":"F","height":165,"grade":90}]`;

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

    const data = await fetchJsonWithTimeout(`${SILICONFLOW_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SILICONFLOW_KEY}`
        },
        body: JSON.stringify(payload),
        provider: 'siliconflow',
        timeoutMs: OCR_PROVIDER_TIMEOUT_MS,
    });

    let content = data.choices[0]?.message?.content || '[]';
    // Clean up markdown code blocks if present
    content = content.replace(/```json/g, '').replace(/```/g, '').trim();
    let students;
    try {
        students = JSON.parse(content);
    } catch {
        throw new Error('VLM 返回了无法解析的 JSON');
    }
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

    const data = await fetchJsonWithTimeout(`${SILICONFLOW_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SILICONFLOW_KEY}`
        },
        body: JSON.stringify(payload),
        provider: 'siliconflow',
        timeoutMs: OCR_PROVIDER_TIMEOUT_MS,
    });

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
    if (!canAttemptMineruDownload()) {
        const mineruStatus = getMineruDownloadAvailability();
        throw new Error(`MinerU unavailable/cooldown: ${mineruStatus.reason || 'unknown'}`);
    }

    const baseUrl = MINERU_URL;
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MINERU_KEY}`
    };

    // Step 1: Get Upload Link
    console.log('[MinerU OCR] Step 1: Getting upload URL...');
    const batchData = await fetchJsonWithTimeout(`${baseUrl}/api/v4/file-urls/batch`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            files: [{ name: filename }],
            enable_formula: false,
            enable_table: true
        }),
        provider: 'mineru',
        timeoutMs: MINERU_API_TIMEOUT_MS,
    });

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
            uploadRes = await fetchWithBudget(uploadUrl, {
                method: 'PUT',
                body: imageBuffer,
                provider: 'mineru-upload',
                timeoutMs: MINERU_API_TIMEOUT_MS,
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

        let resultData;
        try {
            resultData = await fetchJsonWithTimeout(`${baseUrl}/api/v4/extract-results/batch/${batchId}`, {
                method: 'GET',
                headers,
                provider: 'mineru',
                timeoutMs: MINERU_API_TIMEOUT_MS,
            });
        } catch {
            continue;
        }
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
                            return await fetchTextWithTimeout(extractResult.markdown_url, {
                                provider: 'mineru-markdown',
                                timeoutMs: MINERU_API_TIMEOUT_MS,
                            });
                        }
                        return '[MinerU extraction done but cannot parse zip]';
                    }

                    const zipBuffer = await fetchMineruZipWithRetry(extractResult.full_zip_url, {
                        logger: console,
                    });
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
请提取：姓名(name)、性别(gender, M/F)、身高(height, 数字, 单位厘米)、成绩(grade, 数字)。
如果性别不确定，根据中文名字推测（常见男名/女名）。
如果身高看不清或未知，不填或填 null。
如果成绩未知，不填。
忽略非学生信息的文字。

文本内容：
${text.substring(0, 5000)}

输出严格的JSON对象，不要Markdown标记：
{"students": [{"name": "张三", "gender": "M", "height": 170, "grade": 85}, ...]}
    `;

    const data = await fetchJsonWithTimeout(`${DEEPSEEK_BASE}/chat/completions`, {
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
        }),
        provider: 'deepseek',
        timeoutMs: DEEPSEEK_PROVIDER_TIMEOUT_MS,
    });

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
