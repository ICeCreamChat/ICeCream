import { MOCK_DATA } from '../solver/config.js';
import { describeImageWithVision, extractTextWithVisionOCR } from '../solver/siliconflow.js';
import { createGeoGebraPlan } from './geogebra-agent.js';

const MAX_IMAGE_CONTEXT_CHARS = 1400;
const DEFAULT_IMAGE_MESSAGE = '请解析上传的数学题目，优先重建题图或可交互几何图形，不需要输出完整解题步骤。';

function truncateText(value, limit = MAX_IMAGE_CONTEXT_CHARS) {
    const text = String(value || '').trim();
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function parseJsonField(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch {
        return fallback;
    }
}

function shouldUseMockVision(env = process.env) {
    return env.GEOGEBRA_IMAGE_FORCE_MOCK === 'true'
        || !env.SILICONFLOW_API_KEY
        || String(env.SILICONFLOW_API_KEY).includes('your_');
}

async function readImageContext(imagePath, options = {}) {
    const env = options.env || process.env;
    if (shouldUseMockVision(env)) {
        return {
            visionResult: MOCK_DATA.siliconflow,
            ocrResult: MOCK_DATA.mineru,
        };
    }

    try {
        const visionResult = await describeImageWithVision(imagePath);
        const ocrResult = await extractTextWithVisionOCR(imagePath, visionResult.description || '');
        return { visionResult, ocrResult };
    } catch (error) {
        return {
            visionResult: {
                description: `视觉解析暂不可用：${error?.message || 'unknown error'}`,
            },
            ocrResult: {
                success: false,
                text: '',
            },
        };
    }
}

export function buildGeoGebraImagePlanBody(body = {}, imageContext = {}) {
    const userMessage = String(body.message || '').trim() || DEFAULT_IMAGE_MESSAGE;
    const extractedText = truncateText(imageContext.extractedText);
    const imageDescription = truncateText(imageContext.imageDescription);

    return {
        message: [
            userMessage,
            '上传题目 OCR 文本：',
            extractedText || '未识别到稳定文字，请主要根据图形描述构图。',
            '上传题目图形描述：',
            imageDescription || '未识别到稳定图形描述，请生成基础可交互几何草图。',
            '输出要求：只返回 GeoGebra 可执行命令计划，优先绘制题目图形、点线圆和可拖动对象。',
        ].join('\n'),
        canvas: parseJsonField(body.canvas, {}),
        selectedObjects: parseJsonField(body.selectedObjects, []),
        preferredPerspective: body.preferredPerspective || 'G',
    };
}

export async function createGeoGebraImagePlan(body = {}, imagePath, options = {}) {
    if (!imagePath) {
        const imageError = new Error('请上传题目图片');
        imageError.status = 400;
        throw imageError;
    }

    const { visionResult, ocrResult } = await readImageContext(imagePath, options);
    const imageContext = {
        extractedText: ocrResult?.text || '',
        imageDescription: visionResult?.description || '',
    };
    const planBody = buildGeoGebraImagePlanBody(body, imageContext);
    const planPayload = await createGeoGebraPlan(planBody, options);

    return {
        ...planPayload,
        data: {
            ...(planPayload.data || {}),
            extractedText: imageContext.extractedText,
            imageDescription: imageContext.imageDescription,
            studioNotes: planPayload.data?.studioNotes || '已根据上传题目解析并生成 GeoGebra 绘图命令',
        },
    };
}
