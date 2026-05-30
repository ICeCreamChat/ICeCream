/**
 * ICeCream Solver - DeepSeek Integration
 * Ported from MathSolver
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 */

import fetch from 'node-fetch';
import { CONFIG, MOCK_DATA } from './config.js';

const SOLVER_DEFAULT_MAX_TOKENS = 8192;
const SOLVER_MIN_MAX_TOKENS = 1024;
const SOLVER_MAX_CONTINUATIONS = 2;
const INCOMPLETE_SOLUTION_NOTICE = '本次回答可能仍未完整，请重新生成或简化题目。';

const DEEPSEEK_SYSTEM_PROMPT = `你是一位专业的数学解题助手，面向小学、初中、高中学生。请严格按以下四段式结构回答：

**第一步：模型判断**
识别题目类型和所属数学模型，用 1-2 句话说明。

**第二步：解题思路**
简述解题主线和关键步骤，不展开无关分支。

**第三步：详细步骤**
给出完整的计算或证明过程。
- 使用 LaTeX 格式书写数学公式
- 独立公式用 $$...$$ 包裹
- 行内公式用 $...$ 包裹
- 步骤编号清晰，逻辑严谨
- 对长题先收敛主线推导，避免在分支判断里反复发散

**第四步：最终答案**
必须明确给出最终答案。选择题要写出选项和值；证明题要写出结论；计算题要写出最终结果。

请确保解答准确、步骤完整、语言简洁。`;

function buildChatCompletionsUrl(baseUrl, fallbackUrl) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) return fallbackUrl;
    return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function getDeepSeekConfig(env = process.env) {
    return {
        apiKey: env.DEEPSEEK_API_KEY || CONFIG.deepseek.apiKey,
        url: buildChatCompletionsUrl(env.DEEPSEEK_API_BASE, CONFIG.deepseek.url),
        model: env.DEEPSEEK_MODEL || CONFIG.deepseek.model || 'deepseek-chat',
    };
}

export function getSolverMaxTokens(env = process.env) {
    const configured = Number.parseInt(env.SOLVER_DEEPSEEK_MAX_TOKENS, 10);
    if (Number.isInteger(configured) && configured >= SOLVER_MIN_MAX_TOKENS) {
        return configured;
    }
    return SOLVER_DEFAULT_MAX_TOKENS;
}

function buildSolverUserPrompt(extractedText, imageDescription) {
    return `【题目文字内容】
${extractedText || '无'}

【图形描述】
${imageDescription || '无'}

请根据以上信息，按规定的四段式结构完整解答这道题。`;
}

function buildSolverMessages(extractedText, imageDescription) {
    return [
        { role: 'system', content: DEEPSEEK_SYSTEM_PROMPT },
        { role: 'user', content: buildSolverUserPrompt(extractedText, imageDescription) },
    ];
}

function buildContinuationMessages(baseMessages, currentAnswer) {
    return [
        ...baseMessages,
        { role: 'assistant', content: currentAnswer || '' },
        {
            role: 'user',
            content: [
                '从上一段中断处继续，不要重复前文。',
                '请补完剩余推导，并必须以“**第四步：最终答案**”收束。',
                '如果前文已经足够，只补最终答案和必要校正。',
            ].join('\n'),
        },
    ];
}

function hasFinalAnswerSection(text = '') {
    return /(?:第四步[：:\s]*)?最终答案|(?:^|\n)\s*(?:\*\*)?(?:答案|结论)[：:]/.test(text);
}

function hasUnclosedMath(text = '') {
    const withoutEscapedDollars = String(text).replace(/\\\$/g, '');
    const blockDelimiterCount = (withoutEscapedDollars.match(/\$\$/g) || []).length;
    if (blockDelimiterCount % 2 !== 0) return true;

    const withoutClosedBlocks = withoutEscapedDollars.replace(/\$\$[\s\S]*?\$\$/g, '');
    const inlineDelimiterCount = (withoutClosedBlocks.match(/\$/g) || []).length;
    return inlineDelimiterCount % 2 !== 0;
}

function hasUnbalancedBrackets(text = '') {
    const pairs = [
        ['(', ')'],
        ['[', ']'],
        ['{', '}'],
        ['（', '）'],
        ['【', '】'],
    ];
    return pairs.some(([open, close]) => {
        const openCount = (String(text).match(new RegExp(`\\${open}`, 'g')) || []).length;
        const closeCount = (String(text).match(new RegExp(`\\${close}`, 'g')) || []).length;
        return openCount > closeCount;
    });
}

function endsMidThought(text = '') {
    const compact = String(text).trim().replace(/\s+/g, ' ');
    if (!compact) return true;

    const tail = compact.slice(-80);
    if (/[。.!！?？）)\]】」』]$/.test(compact)) {
        return /(因此|所以|故|则|需要|判断|检查|若|如果|由于|因为|代入|得到|可得|继续|再检查)$/.test(tail);
    }

    return /(因此|所以|故|则|需要|判断|检查|若|如果|由于|因为|代入|得到|可得|继续|再检查|证明|计算|化简|为|是|即|=|\\frac|\\sqrt|[,，;；:：、+\-*/=])$/.test(tail);
}

export function isLikelyIncompleteSolverAnswer(answer = '', finishReason = '') {
    const text = String(answer || '').trim();
    if (!text) return true;
    if (finishReason === 'length') return true;
    if (!hasFinalAnswerSection(text)) return true;
    if (hasUnclosedMath(text)) return true;
    if (hasUnbalancedBrackets(text)) return true;
    if (endsMidThought(text)) return true;
    return false;
}

function mergeAnswerParts(parts) {
    return parts
        .map(part => String(part || '').trim())
        .filter(Boolean)
        .join('\n\n');
}

function combineUsage(usages = []) {
    const total = {};
    for (const usage of usages) {
        if (!usage || typeof usage !== 'object') continue;
        for (const [key, value] of Object.entries(usage)) {
            if (typeof value === 'number' && Number.isFinite(value)) {
                total[key] = (total[key] || 0) + value;
            }
        }
    }
    return Object.keys(total).length ? total : undefined;
}

async function requestSolverCompletion(messages, options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetchImpl || fetch;
    const config = getDeepSeekConfig(env);

    const response = await fetchImpl(config.url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
            model: config.model,
            messages,
            temperature: 0.35,
            max_tokens: getSolverMaxTokens(env),
        }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data?.error?.message || `DeepSeek API 错误: ${response.status}`);
    }

    const choice = data.choices?.[0] || {};
    return {
        content: choice.message?.content || '',
        finishReason: choice.finish_reason || null,
        usage: data.usage,
    };
}

export async function solveWithDeepSeek(extractedText, imageDescription, options = {}) {
    const env = options.env || process.env;
    const config = getDeepSeekConfig(env);
    if (!config.apiKey) {
        return {
            ...MOCK_DATA.deepseek,
            solverMeta: {
                finishReason: 'mock',
                continuationCount: 0,
                completed: true,
                usage: undefined,
            },
        };
    }

    try {
        const baseMessages = buildSolverMessages(extractedText, imageDescription);
        const answerParts = [];
        const usages = [];

        let completion = await requestSolverCompletion(baseMessages, options);
        let finishReason = completion.finishReason;
        answerParts.push(completion.content);
        usages.push(completion.usage);

        let answer = mergeAnswerParts(answerParts);
        let continuationCount = 0;

        while (
            continuationCount < SOLVER_MAX_CONTINUATIONS
            && isLikelyIncompleteSolverAnswer(answer, finishReason)
        ) {
            continuationCount += 1;
            completion = await requestSolverCompletion(buildContinuationMessages(baseMessages, answer), options);
            finishReason = completion.finishReason || finishReason;
            if (!String(completion.content || '').trim()) break;
            answerParts.push(completion.content);
            usages.push(completion.usage);
            answer = mergeAnswerParts(answerParts);
        }

        const completed = !isLikelyIncompleteSolverAnswer(answer, finishReason);
        const finalAnswer = completed || answer.includes(INCOMPLETE_SOLUTION_NOTICE)
            ? answer
            : `${answer}\n\n> ⚠️ ${INCOMPLETE_SOLUTION_NOTICE}`;

        return {
            answer: finalAnswer,
            solverMeta: {
                finishReason,
                continuationCount,
                completed,
                usage: combineUsage(usages),
            },
        };
    } catch (error) {
        console.error('[DeepSeek Error]', error);
        return {
            answer: '',
            error: error.message,
            solverMeta: {
                finishReason: 'error',
                continuationCount: 0,
                completed: false,
                usage: undefined,
            },
        };
    }
}

export async function chatWithDeepSeek(messages, model = null, temperature = 0.7, options = {}) {
    const env = options.env || process.env;
    const config = getDeepSeekConfig(env);
    if (!config.apiKey) {
        return {
            choices: [{
                message: {
                    role: 'assistant',
                    content: '【Mock 模式】这是模拟回复（API Key 未配置）。',
                },
            }],
        };
    }

    try {
        const response = await (options.fetchImpl || fetch)(config.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
                model: model || config.model || 'deepseek-chat',
                messages,
                temperature,
                stream: false,
            }),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`DeepSeek API Error: ${err}`);
        }

        return await response.json();
    } catch (error) {
        console.error('[DeepSeek Chat Error]', error);
        throw error;
    }
}

export default { solveWithDeepSeek, chatWithDeepSeek };
