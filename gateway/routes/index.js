import aiRoutes from './ai.js';
import chatRoutes from './chat.js';
import geogebraRoutes from './geogebra.js';
import manimRoutes from './manim.js';
import solverRoutes from './solver.js';
import toolsRoutes from './tools.js';
import timetableAgentRoutes from './timetable-agent.js';
import timetableConstraintChatRoutes from './timetable-constraint-chat.js';
import timetableRoutes from './timetable.js';
import { upload } from '../middleware/upload.js';
import { intentRouter } from '../middleware/intent-router.js';

export function registerApiRoutes(app) {
    app.post('/api/message', upload.single('image'), intentRouter);
    app.use('/api/ai', aiRoutes);
    app.use('/api/chat', chatRoutes);
    app.use('/api/geogebra', geogebraRoutes);
    app.use('/api/manim', manimRoutes);
    app.use('/api/solver', solverRoutes);
    app.use('/api/timetable/agent', timetableAgentRoutes);
    app.use('/api/tools/timetable', timetableRoutes);
    app.use('/api/tools/timetable', timetableConstraintChatRoutes);
    app.use('/api/tools/timetable/agent', timetableAgentRoutes);
    app.use('/api/tools', toolsRoutes);
}
