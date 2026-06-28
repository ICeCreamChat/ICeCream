/**
 * Tools Routes - 课堂工具箱 API 路由组合入口
 */

import express from 'express';
import fetch from 'node-fetch';

import { checkTimefoldStatus } from '../services/seating-solver-bridge.js';
import seatingRoutes from './tools/seating/index.js';

const router = express.Router();

router.get('/health', async (req, res) => {
    const timefold = await checkTimefoldStatus({ env: process.env, fetchImpl: fetch });
    res.json({
        status: 'ok',
        service: 'Classroom Tools',
        version: '2.0.0',
        tools: ['seating', 'timetable', 'picker', 'vote'],
        services: { timefold },
    });
});

router.use('/seating', seatingRoutes);

router.post('/vote/create', async (req, res) => {
    res.json({ success: false, error: '功能开发中...' });
});

router.get('/picker/students', async (req, res) => {
    res.json({ success: true, data: { students: [] } });
});

export default router;
