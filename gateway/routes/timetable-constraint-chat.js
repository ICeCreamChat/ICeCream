import { randomUUID } from 'node:crypto';
import express from 'express';
import { TimetableConstraintConversation } from '../services/timetable-constraint-conversation.js';
import { autoScanConstraints, generateAutoFix } from '../services/timetable-auto-scanner.js';

const router = express.Router();
const conversations = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 1000;

function badRequest(message) {
    const error = new Error(message);
    error.status = 400;
    return error;
}

function sendError(res, error, fallback = '约束对话处理失败') {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    res.status(status).json({
        success: false,
        error: error?.message || fallback,
    });
}

function requireConversation(conversationId) {
    const conversation = conversations.get(conversationId);
    if (!conversation) {
        const error = new Error('对话会话不存在或已过期，请重新开始。');
        error.status = 404;
        throw error;
    }
    return conversation;
}

function scheduleCleanup(conversationId) {
    const timer = setTimeout(() => conversations.delete(conversationId), SESSION_TTL_MS);
    if (typeof timer.unref === 'function') timer.unref();
}

router.post('/constraints/chat/init', async (req, res) => {
    try {
        const { constraints, project = {}, reviewContext = {} } = req.body || {};
        if (!Array.isArray(constraints)) {
            throw badRequest('constraints 必须是数组。');
        }
        if (reviewContext && typeof reviewContext !== 'object') {
            throw badRequest('reviewContext 必须是对象。');
        }

        const conversation = new TimetableConstraintConversation();
        conversation.initialize(constraints, project, reviewContext);

        const conversationId = `conv_${Date.now()}_${randomUUID()}`;
        conversations.set(conversationId, conversation);
        scheduleCleanup(conversationId);

        res.json({
            success: true,
            data: {
                conversationId,
                welcomeMessage: conversation.history[0]?.content || '',
                constraints: conversation.constraints,
                reviewContext: conversation.reviewContext,
                suggestedPrompts: conversation.suggestedPrompts,
            },
        });
    } catch (error) {
        console.error('Init constraint conversation error:', error);
        sendError(res, error, '约束对话初始化失败');
    }
});

router.post('/constraints/chat/message', async (req, res) => {
    try {
        const { conversationId, message, intent = 'general', taskContext = null } = req.body || {};
        if (!conversationId || typeof conversationId !== 'string') {
            throw badRequest('conversationId 不能为空。');
        }
        if (typeof message !== 'string' || !message.trim()) {
            throw badRequest('message 不能为空。');
        }
        if (message.length > MAX_MESSAGE_LENGTH) {
            throw badRequest(`message 不能超过 ${MAX_MESSAGE_LENGTH} 个字符。`);
        }

        const conversation = requireConversation(conversationId);
        const result = await conversation.chat(message.trim(), process.env, globalThis.fetch, { intent, taskContext });

        res.json({
            success: true,
            data: result,
        });
    } catch (error) {
        console.error('Constraint chat message error:', error);
        sendError(res, error, '约束对话处理失败');
    }
});

router.get('/constraints/chat/:conversationId/history', (req, res) => {
    try {
        const conversation = requireConversation(req.params.conversationId);

        res.json({
            success: true,
            data: {
                history: conversation.history,
                constraints: conversation.constraints,
            },
        });
    } catch (error) {
        sendError(res, error, '约束对话历史读取失败');
    }
});

router.post('/constraints/chat/:conversationId/finalize', (req, res) => {
    try {
        const { conversationId } = req.params;
        const conversation = requireConversation(conversationId);
        const constraints = conversation.constraints;
        conversations.delete(conversationId);

        res.json({
            success: true,
            data: {
                constraints,
                message: '约束优化已完成。',
            },
        });
    } catch (error) {
        sendError(res, error, '约束对话结束失败');
    }
});

// 智能助手：自动扫描约束问题
router.post('/constraints/scan', async (req, res) => {
    try {
        const { constraints = [], project = {} } = req.body || {};
        if (!Array.isArray(constraints)) throw badRequest('constraints 必须是数组。');
        const result = await autoScanConstraints(constraints, project);
        res.json({
            success: true,
            data: result,
        });
    } catch (error) {
        sendError(res, error, '约束扫描失败');
    }
});

// 智能助手：生成单个问题的修复方案
router.post('/constraints/generate-fix', async (req, res) => {
    try {
        const { problem = null, project = {} } = req.body || {};
        if (!problem) throw badRequest('缺少要修复的问题信息。');
        const fix = await generateAutoFix(problem, project);
        res.json({
            success: true,
            data: { fix },
        });
    } catch (error) {
        sendError(res, error, '修复方案生成失败');
    }
});

export default router;
