import express from 'express';
import multer from 'multer';
import { extractStudentsDirectVLM, recognizeWithPaddle, recognizeWithMinerU, extractStudentsWithAI } from '../../../services/ocr.js';
import {
    buildImageImportReview,
    mergeStudentDetails,
    normalizeSeatingStudents,
    parseRosterFile,
    parseStudentsText,
} from '../../../services/seating-roster.js';
import { imageUploadFilter, sanitizeUploadFilename } from '../../../security.js';

const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: imageUploadFilter,
    limits: { fileSize: 20 * 1024 * 1024 },
});

const rosterUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
});

const router = express.Router();

/**
 * POST /api/tools/seating/parse-students
 * 解析粘贴的学生名单 (Excel/文本)
 */
router.post('/parse-students', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) {
            return res.status(400).json({                success: false,                error: '请提供学生名单文本'            });
        }

        const { students, count } = parseStudentsText(text);
        res.json({
            success: true,
            data: {
                students,
                count
            }
        });

    } catch (error) {
        console.error('[Tools/Seating/ParseStudents] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/tools/seating/parse-students-file
 * 解析上传的名单文件 (CSV/TXT/XLSX/文本型 XLS)
 */
router.post('/parse-students-file', rosterUpload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: '请上传名单文件' });
        }

        const result = await parseRosterFile({
            buffer: req.file.buffer,
            originalname: sanitizeUploadFilename(req.file.originalname),
            mimetype: req.file.mimetype
        });

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('[Tools/Seating/ParseStudentsFile] Error:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/tools/seating/parse-image
 * 从图片导入学生名单 (OCR -> AI)
 */
router.post('/parse-image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: '请上传图片' });
        }

        const buffer = req.file.buffer;
        const mimeType = req.file.mimetype;
        const filename = sanitizeUploadFilename(req.file.originalname);

        console.log(`[Seating/ParseImage] Processing ${filename} (${mimeType}, ${buffer.length} bytes)`);

        let studentsWithIds = [];
        let source = '';
        let ocrText = '';
        let ocrSource = '';

        // === Tier 1: VLM Direct Extraction (image → JSON, one step) ===
        try {
            console.log('[Seating/ParseImage] Trying VLM Direct Extraction (Primary)...');
            const students = await extractStudentsDirectVLM(buffer, mimeType);
            if (students && students.length > 0) {
                source = 'vlm-direct';
                studentsWithIds = normalizeSeatingStudents(students);
            }
        } catch (err) {
            console.warn('[Seating/ParseImage] VLM Direct failed:', err.message);
        }

        const needsHeightFallback = () => studentsWithIds.some(student => student.height === undefined || student.height === null || student.height === '');

        // === Tier 2: OCR text fallback for missing students or missing height ===
        if (studentsWithIds.length === 0 || needsHeightFallback()) {
            try {
                console.log('[Seating/ParseImage] Trying MinerU + DeepSeek (Fallback 1)...');
                ocrText = await recognizeWithMinerU(buffer, filename);
                if (ocrText) ocrSource = 'mineru';
            } catch (err) {
                console.warn('[Seating/ParseImage] MinerU failed:', err.message);
            }

            // === Tier 3: VLM OCR + DeepSeek AI ===
            if (!ocrText) {
                try {
                    console.log('[Seating/ParseImage] Trying VLM OCR + DeepSeek (Fallback 2)...');
                    ocrText = await recognizeWithPaddle(buffer, mimeType);
                    if (ocrText) ocrSource = 'vlm-ocr';
                } catch (err) {
                    console.warn('[Seating/ParseImage] VLM OCR failed:', err.message);
                }
            }

            if (ocrText) {
                const parsed = parseStudentsText(ocrText).students;
                if (parsed.length) {
                    studentsWithIds = mergeStudentDetails(studentsWithIds, parsed);
                    source = source ? `${source}+${ocrSource}` : ocrSource;
                }

                if (studentsWithIds.length === 0 || needsHeightFallback()) {
                    console.log(`[Seating/ParseImage] OCR success (${ocrSource}), extracting with DeepSeek...`);
                    const students = await extractStudentsWithAI(ocrText);
                    studentsWithIds = mergeStudentDetails(studentsWithIds, students);
                    source = source ? `${source}+ai` : `${ocrSource}+ai`;
                }
            }
        }

        if (studentsWithIds.length === 0) {
            return res.status(500).json({ success: false, error: 'OCR 识别失败，请尝试其他图片' });
        }

        const review = buildImageImportReview(studentsWithIds);
        console.log(`[Seating/ParseImage] Extracted ${studentsWithIds.length} students via ${source}`);

        res.json({
            success: true,
            data: {
                students: review.students,
                count: review.count,
                source,
                needsReview: review.needsReview,
                warnings: review.warnings
            }
        });

    } catch (error) {
        console.error('[Seating/ParseImage] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
