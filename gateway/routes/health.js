export function registerHealthRoute(app) {
    app.get('/api/health', (req, res) => {
        res.json({
            status: 'ok',
            service: 'ICeCream Gateway',
            version: '1.0.0',
            timestamp: new Date().toISOString(),
            // 智能排课 2.0 回退开关：env TIMETABLE_V2_ENABLED 显式设为 'false' 才回退旧版，默认启用 V2。
            timetableV2Enabled: String(process.env.TIMETABLE_V2_ENABLED ?? 'true').toLowerCase() !== 'false',
        });
    });
}
