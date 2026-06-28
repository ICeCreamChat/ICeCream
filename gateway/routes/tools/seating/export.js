import express from 'express';
import {
    buildSeatingExportXlsx,
    normalizeSeatingExportRequest,
    SEATING_XLSX_MIME,
} from '../../../services/seating-export.js';

const router = express.Router();

/**
 * POST /api/tools/seating/export-xlsx
 * Generate a styled Excel workbook from the current seating snapshot.
 */
router.post('/export-xlsx', (req, res) => {
    try {
        const snapshot = normalizeSeatingExportRequest(req.body);
        const buffer = buildSeatingExportXlsx(snapshot);
        const filename = encodeURIComponent(`座位表_${new Date().toISOString().slice(0, 10)}.xlsx`);
        res.setHeader('Content-Type', SEATING_XLSX_MIME);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
        res.send(buffer);
    } catch (error) {
        res.status(400).json({
            success: false,
            error: error.message || '座位表导出失败',
        });
    }
});

export default router;
