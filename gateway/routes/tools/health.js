import fetch from 'node-fetch';

import { checkTimefoldStatus } from '../../services/seating-solver-bridge.js';

export function registerToolsHealthRoute(router) {
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
}
