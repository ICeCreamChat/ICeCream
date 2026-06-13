/**
 * 约束对话API路由
 * 支持用户通过自然语言与AI讨论优化约束
 */

import express from 'express';
import { TimetableConstraintConversation } from '../services/timetable-constraint-conversation.js';

const router = express.Router();

// 存储活跃的对话会话（生产环境应使用Redis）
const conversations = new Map();

/**
 * 初始化约束对话
 */
router.post('/constraints/chat/init', async (req, res) => {
    try {
        const { constraints, project } = req.body;

        const conversation = new TimetableConstraintConversation();
        conversation.initialize(constraints, project);

        const conversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        conversations.set(conversationId, conversation);

        // 10分钟后自动清理
        setTimeout(() => conversations.delete(conversationId), 10 * 60 * 1000);

        res.json({
            success: true,
            data: {
                conversationId,
                welcomeMessage: conversation.history[0].content,
                constraints: conversation.constraints
            }
        });
    } catch (error) {
        console.error('Init conversation error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 发送消息到对话
 */
router.post('/constraints/chat/message', async (req, res) => {
    try {
        const { conversationId, message } = req.body;

        const conversation = conversations.get(conversationId);
        if (!conversation) {
            return res.status(404).json({
                success: false,
                error: '对话会话不存在或已过期，请重新开始'
            });
        }

        const result = await conversation.chat(message, process.env, globalThis.fetch);

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({
            success: false,
            error: error.message || '对话处理失败'
        });
    }
});

/**
 * 获取对话历史
 */
router.get('/constraints/chat/:conversationId/history', (req, res) => {
    try {
        const { conversationId } = req.params;

        const conversation = conversations.get(conversationId);
        if (!conversation) {
            return res.status(404).json({
                success: false,
                error: '对话会话不存在'
            });
        }

        res.json({
            success: true,
            data: {
                history: conversation.history,
                constraints: conversation.constraints
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 结束对话并返回最终约束
 */
router.post('/constraints/chat/:conversationId/finalize', (req, res) => {
    try {
        const { conversationId } = req.params;

        const conversation = conversations.get(conversationId);
        if (!conversation) {
            return res.status(404).json({
                success: false,
                error: '对话会话不存在'
            });
        }

        const constraints = conversation.constraints;
        conversations.delete(conversationId);

        res.json({
            success: true,
            data: {
                constraints,
                message: '约束优化已完成'
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

export default router;
