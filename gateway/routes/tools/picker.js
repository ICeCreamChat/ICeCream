export function registerToolsPickerRoutes(router) {
    router.get('/picker/students', async (req, res) => {
        res.json({ success: true, data: { students: [] } });
    });
}
