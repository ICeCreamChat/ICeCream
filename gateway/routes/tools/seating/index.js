import express from 'express';

import arrangeRoutes from './arrange.js';
import suggestionsRoutes from './suggestions.js';
import feedbackRoutes from './feedback.js';
import exportRoutes from './export.js';
import rulesRoutes from './rules.js';
import layoutRoutes from './layout.js';
import rosterRoutes from './roster.js';
import chatRoutes from './chat.js';

const router = express.Router();

router.use(arrangeRoutes);
router.use(suggestionsRoutes);
router.use(feedbackRoutes);
router.use(exportRoutes);
router.use(rulesRoutes);
router.use(layoutRoutes);
router.use(rosterRoutes);
router.use(chatRoutes);

export default router;
