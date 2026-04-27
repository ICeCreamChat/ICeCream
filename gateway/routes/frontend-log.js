export function registerFrontendLogRoute(app, logger = console) {
    app.post('/api/log', (req, res) => {
        const { level, message, data } = req.body;
        const timestamp = new Date().toISOString().slice(11, 19);
        const prefix = `[${timestamp}] [FRONTEND]`;

        switch (level) {
            case 'error':
                logger.error(`${prefix} ERROR ${message}`, data || '');
                break;
            case 'warn':
                logger.warn(`${prefix} WARN ${message}`, data || '');
                break;
            case 'info':
                logger.log(`${prefix} INFO ${message}`, data || '');
                break;
            default:
                logger.log(`${prefix} LOG ${message}`, data || '');
        }

        res.json({ received: true });
    });
}
