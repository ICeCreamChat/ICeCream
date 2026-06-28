/**
 * Tools Routes - 课堂工具箱 API 路由组合入口
 */

import express from 'express';

import { registerToolsHealthRoute } from './tools/health.js';
import seatingRoutes from './tools/seating/index.js';
import { registerToolsVoteRoutes } from './tools/vote.js';
import { registerToolsPickerRoutes } from './tools/picker.js';

const router = express.Router();

registerToolsHealthRoute(router);
router.use('/seating', seatingRoutes);
registerToolsVoteRoutes(router);
registerToolsPickerRoutes(router);

export default router;
