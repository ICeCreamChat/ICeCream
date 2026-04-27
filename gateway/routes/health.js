export function registerHealthRoute(app) {
    app.get('/api/health', (req, res) => {
        res.json({
            status: 'ok',
            service: 'ICeCream Gateway',
            version: '1.0.0',
            timestamp: new Date().toISOString(),
        });
    });
}
