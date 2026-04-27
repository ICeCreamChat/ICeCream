/**
 * Tools Routes - 课堂工具箱 API 路由
 * Smart Seating Planner + Other Tools
 */

import express from 'express';
import fetch from 'node-fetch';
import multer from 'multer';
import { extractStudentsDirectVLM, recognizeWithPaddle, recognizeWithMinerU, extractStudentsWithAI } from '../services/ocr.js';
import {
    normalizeArrangeRequest,
    runAiDrivenArrangement,
} from '../services/seating-arrange.js';
import {
    buildSeatingChatSnapshot,
    normalizeChatOperations,
    resolveEmptyMutationResponse,
} from '../services/seating-chat.js';
import {
    buildSeatingPlanResponse,
    normalizePlanRequest,
} from '../services/seating-layout.js';
import { parseRosterFile, parseStudentsText } from '../services/seating-roster.js';
import { imageUploadFilter, sanitizeUploadFilename } from '../security.js';

const upload = multer({    storage: multer.memoryStorage(),
    fileFilter: imageUploadFilter,
    limits: { fileSize: 20 * 1024 * 1024 } // 20MB (images compressed client-side)
});

const rosterUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
});

const router = express.Router();

// ================================
// Health Check
// ================================
router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Classroom Tools',
        version: '2.0.0',
        tools: ['seating', 'sound', 'picker', 'vote']
    });
});

// ================================
// Seating Planner API
// ================================

/**
 * POST /api/tools/seating/arrange
 * AI-driven first-pass classroom layout + seating arrangement.
 */
router.post('/seating/arrange', async (req, res) => {
    let arrangeRequest;
    try {
        arrangeRequest = normalizeArrangeRequest(req.body);
    } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
    }

    try {
        const data = await runAiDrivenArrangement({
            request: arrangeRequest,
            fetchImpl: fetch,
            env: process.env,
        });
        return res.json({
            success: true,
            data,
        });
    } catch (error) {
        console.error('[Seating/Arrange] Error:', error.message);
        return res.status(502).json({
            success: false,
            error: error.message || 'AI 排座服务暂时不可用',
        });
    }
});

/**
 * POST /api/tools/seating/parse
 * 自然语言约束解析 → JSON
 */
router.post('/seating/parse', async (req, res) => {
    try {
        const { text, students } = req.body;
        if (!text) {
            return res.status(400).json({                success: false,                error: '请提供约束描述文本'            });
        }

        const systemPrompt = `你是座位安排约束解析助手。从老师的话中提取约束条件。

输出格式 (严格JSON，不要markdown):
{
  "constraints": [
    {"type": "front_row", "target": "张三", "reason": "视力不好", "priority": "hard"},
    {"type": "avoid", "target": "李四", "related": "王五", "reason": "爱讲话", "priority": "hard"},
    {"type": "prefer", "target": "赵六", "related": "钱七", "reason": "学生心愿", "priority": "soft"}
  ]
}

约束类型:
- front_row: 必须坐前排 (视力/身高等硬需求)
- back_row: 必须坐后排 (个子高)
- avoid: 两人不能相邻 (纪律问题)
- prefer: 希望相邻 (软约束/心愿)
- pair: 必须相邻 (学习互助等硬约束)

priority: hard=必须满足, soft=尽量满足

如果没有识别到约束，返回空数组: {"constraints": []}`;

        const response = await fetch(`${process.env.DEEPSEEK_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `老师说：${text}\n\n${students ? `学生名单：${students.map(s => s.name).join('、')}` : ''}` }
                ],
                temperature: 0.3,
                max_tokens: 1024,
                response_format: { type: "json_object" }
            }),
            signal: AbortSignal.timeout(60000) // 60s timeout
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `API Error: ${response.status}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '{}';
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (e) {
            parsed = { constraints: [] };
        }

        res.json({
            success: true,
            data: {
                constraints: parsed.constraints || [],
                raw: content
            }
        });

    } catch (error) {
        console.error('[Tools/Seating/Parse] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/tools/seating/plan
 * 生成座位表 (含一致性校验)
 */
/**
 * POST /api/tools/seating/plan
 * AI Custom Layout Generator (Role 2)
 * Generates grid structure (seats/aisles) from natural language description
 */
router.post('/seating/plan', async (req, res) => {
    try {
        const planRequest = normalizePlanRequest(req.body);
        const { prompt, rows, cols, groupSize, guardiansEnabled } = planRequest;

        if (!prompt) {
            const data = buildSeatingPlanResponse({
                ...planRequest,
                reasoning: '已应用预设教室布局'
            });
            return res.json({ success: true, data });
        }

        const systemPrompt = `你是教室布局专家。用户希望在一个 ${rows}行 × ${cols}列 的网格中设计特殊的座位布局。

【任务】根据用户描述，生成布局矩阵。
- 标记为 1 的位置是座位
- 标记为 0 的位置是过道/空地

【常用布局参考】
- "U型": 只有三边有座位，中间空
- "小组": 4-6人一组，组间有过道
- "圆桌": (近似)- "两侧": 中间大过道
- "三人一组/两人一组": 每组座位连续，中间不要跨过道
- "护法": 由 guardiansEnabled 表示，不要放入矩阵

【输出格式 (Strict JSON)】
{
  "matrix": [
    [1, 1, 0, 0, 1, 1],
    [1, 1, 0, 0, 1, 1]
  ],
  "reasoning": "设计的简短说明"
}`;

        const response = await fetch(`${process.env.DEEPSEEK_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.DEEPSEEK_CHAT_MODEL || 'deepseek-chat',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.2,
                response_format: { type: "json_object" }
            }),
            signal: AbortSignal.timeout(60000)
        });

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error('AI 无响应');

        let result;
        try {
            result = JSON.parse(content);
        } catch {
            throw new Error('AI 返回格式错误');
        }

        res.json({
            success: true,
            data: buildSeatingPlanResponse({
                rows,
                cols,
                matrix: result.matrix,
                reasoning: result.reasoning || 'AI 教室布局',
                groupSize,
                guardiansEnabled
            })
        });

    } catch (error) {
        console.error('[Seating/Plan] Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/tools/seating/parse-students
 * 解析粘贴的学生名单 (Excel/文本)
 */
router.post('/seating/parse-students', async (req, res) => {
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
router.post('/seating/parse-students-file', rosterUpload.single('file'), async (req, res) => {
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
router.post('/seating/parse-image', upload.single('image'), async (req, res) => {
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

        // === Tier 1: VLM Direct Extraction (image → JSON, one step) ===
        try {
            console.log('[Seating/ParseImage] Trying VLM Direct Extraction (Primary)...');
            const students = await extractStudentsDirectVLM(buffer, mimeType);
            if (students && students.length > 0) {
                source = 'vlm-direct';
                studentsWithIds = students.map((s, i) => ({
                    id: `s${(i + 1).toString().padStart(2, '0')}`,
                    name: s.name,
                    gender: (s.gender === '男' || s.gender === 'M') ? 'M' : 'F',
                    grade: s.grade
                }));
            }
        } catch (err) {
            console.warn('[Seating/ParseImage] VLM Direct failed:', err.message);
        }

        // === Tier 2: MinerU OCR + DeepSeek AI (slower but more thorough) ===
        if (studentsWithIds.length === 0) {
            let text = '';
            try {
                console.log('[Seating/ParseImage] Trying MinerU + DeepSeek (Fallback 1)...');
                text = await recognizeWithMinerU(buffer, filename);
                if (text) source = 'mineru';
            } catch (err) {
                console.warn('[Seating/ParseImage] MinerU failed:', err.message);
            }

            // === Tier 3: VLM OCR + DeepSeek AI ===
            if (!text) {
                try {
                    console.log('[Seating/ParseImage] Trying VLM OCR + DeepSeek (Fallback 2)...');
                    text = await recognizeWithPaddle(buffer, mimeType);
                    if (text) source = 'vlm-ocr';
                } catch (err) {
                    console.warn('[Seating/ParseImage] VLM OCR failed:', err.message);
                }
            }

            if (text) {
                console.log(`[Seating/ParseImage] OCR success (${source}), extracting with DeepSeek...`);
                const students = await extractStudentsWithAI(text);
                studentsWithIds = students.map((s, i) => ({
                    id: `s${(i + 1).toString().padStart(2, '0')}`,
                    name: s.name,
                    gender: (s.gender === '男' || s.gender === 'M') ? 'M' : 'F',
                    grade: s.grade
                }));
            }
        }

        if (studentsWithIds.length === 0) {
            return res.status(500).json({ success: false, error: 'OCR 识别失败，请尝试其他图片' });
        }

        console.log(`[Seating/ParseImage] Extracted ${studentsWithIds.length} students via ${source}`);

        res.json({
            success: true,
            data: {
                students: studentsWithIds,
                count: studentsWithIds.length,
                source
            }
        });

    } catch (error) {
        console.error('[Seating/ParseImage] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ================================
// Seating Chat - AI 座后辅助对话
// ================================

/**
 * POST /api/tools/seating/chat
 * AI-powered seat adjustment assistant
 */
router.post('/seating/chat', async (req, res) => {
    try {
        const { message, history = [], layout, students, rows, cols } = req.body;
        if (!message) {
            return res.status(400).json({ success: false, error: '请提供消息' });
        }

        if (!layout || !students) {
            return res.status(400).json({ success: false, error: '请先生成座位表' });
        }

        const studentList = students.map(s => `${s.name}(id:${s.id}, ${s.gender === 'M' ? '男' : s.gender === 'F' ? '女' : '未知'}, 成绩:${s.grade || '无'})`).join(', ');
        const seatingSnapshot = buildSeatingChatSnapshot({ layout, students });
        const seatingLines = seatingSnapshot.occupied.length
            ? seatingSnapshot.occupied.map(seat => `${seat.name}(id:${seat.id}) 在 row:${seat.row}, col:${seat.col}`).join('\n')
            : '当前没有已安排学生';

        const systemPrompt = `你是智能座位助手。老师已经生成了一个 ${rows}×${cols} 的座位表，现在需要你帮忙微调。

【当前座位表】(行号从0开始，_aisle_ 表示过道，null 表示空位)
${layout.map((row, i) => `第${i}行: ${row.map(c => c || '空').join(' | ')}`).join('\n')}

【当前学生坐标】
${seatingLines}

【学生信息】
${studentList}

【你的职责】
1. 理解老师的自然语言指令
2. 回复简短友好的中文说明
3. 如果指令涉及座位调整，返回具体操作

【输出格式 (Strict JSON)】
{
  "reply": "给老师的回复文字",
  "operations": [
    {"type": "swap", "student1Id": "s01", "student2Id": "s02"},
    {"type": "move", "studentId": "s03", "row": 0, "col": 2}
  ]
}

【规则】
- operations 数组可以为空（如仅分析/回答问题时）
- 只要老师要求换座、移动、前后左右挪、安排到某排某列，就必须返回 operations，不能只回复文字
- 操作里优先使用学生 id；如果不确定 id，可以用姓名字段 student/student1/student2
- row/col 必须使用从 0 开始的内部坐标；回复老师时可以说“第1排第3列”
- swap = 交换两人座位
- move = 把某人移到指定位置（原位置的人会被交换过去）
- 如果老师说"往前挪"，找一个更前面的空位或更好的位置
- 回复要简洁，不要太长
- 只输出 JSON，不要 markdown`;

        const messages = [
            { role: 'system', content: systemPrompt },
            ...history.slice(-8).map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: message }
        ];

        const response = await fetch(`${process.env.DEEPSEEK_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.DEEPSEEK_CHAT_MODEL || 'deepseek-chat',
                messages,
                temperature: 0.3,
                max_tokens: 1000,
                response_format: { type: "json_object" }
            }),
            signal: AbortSignal.timeout(30000)
        });

        const data = await response.json();
        if (!data.choices?.[0]?.message?.content) {
            throw new Error('AI 返回为空');
        }

        let content = data.choices[0].message.content.trim();
        // Strip markdown code blocks if present
        content = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch {
            // If JSON parsing fails, treat the whole thing as a reply
            parsed = { reply: content, operations: [] };
        }

        const { operations, rejected } = normalizeChatOperations(
            Array.isArray(parsed.operations) ? parsed.operations : [],
            students
        );
        const emptyMutation = resolveEmptyMutationResponse({ message, operations, rejected });

        res.json({
            success: true,
            data: {
                reply: parsed.reply || '好的',
                operations,
                rejected: emptyMutation.rejected,
                mutationIntent: emptyMutation.mutationIntent,
                needsAction: emptyMutation.needsAction,
                warnings: emptyMutation.warnings
            }
        });

    } catch (err) {
        console.error('[SeatingChat] Error:', err.message);
        res.status(500).json({
            success: false,
            error: err.message || 'AI 服务暂时不可用'
        });
    }
});

// ================================
// Vote System API (保留占位)
// ================================
router.post('/vote/create', async (req, res) => {
    res.json({ success: false, error: '功能开发中...' });
});

// ================================
// Random Picker API (保留占位)
// ================================
router.get('/picker/students', async (req, res) => {
    res.json({ success: true, data: { students: [] } });
});

export default router;
