export function registerToolsVoteRoutes(router) {
    router.post('/vote/create', async (req, res) => {
        res.json({ success: false, error: '功能开发中...' });
    });
}
