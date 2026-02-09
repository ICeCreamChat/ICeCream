/**
 * Tools Routes - 课堂工具箱 API 路由
 * Smart Seating Planner + Other Tools
 */

import express from 'express';
import fetch from 'node-fetch';

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
 * POST /api/tools/seating/parse
 * 自然语言约束解析 → JSON
 */
router.post('/seating/parse', async (req, res) => {
    try {
        const { text, students } = req.body;
        
        if (!text) {
            return res.status(400).json({ 
                success: false, 
                error: '请提供约束描述文本' 
            });
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
            })
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
router.post('/seating/plan', async (req, res) => {
    try {
        const { students, constraints, strategy, rows, cols, aisles = [] } = req.body;
        
        if (!students || !Array.isArray(students) || students.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: '请提供学生名单' 
            });
        }

        const studentCount = students.length;
        const totalSeats = rows * cols - aisles.length;
        
        if (totalSeats < studentCount) {
            return res.status(400).json({
                success: false,
                error: `座位不足: ${totalSeats} 个座位，${studentCount} 名学生`
            });
        }

        const systemPrompt = `你是座位规划算法专家。

【任务】将 ${studentCount} 名学生填入 ${rows}×${cols} 网格。

【规则】
1. 完整性: 输出必须恰好包含所有学生ID，不能多也不能少
2. 空座: 位置多于学生时用 null 填充
3. 过道: 索引 [${aisles.join(',')}] 的列是过道，用 "_aisle_" 标记
4. 优先级: 硬约束 > 避嫌 > 策略 > 心愿

【策略说明】
- genderBalance: 男女尽量交替
- gradeBalance: 成绩好坏搭配
- heightOrder: 按身高从前到后

【输出格式 (Strict JSON，不要markdown)】
{
  "layout": [["s01","s02",null],["s03","s04","s05"]],
  "stats": {"total": ${studentCount}, "gender_mix": 0.85},
  "unsatisfied": [{"target": "s05", "constraint": "front_row", "reason": "前排已满"}]
}`;

        const userContent = `学生列表: ${JSON.stringify(students)}
约束条件: ${JSON.stringify(constraints || [])}
策略: ${JSON.stringify(strategy || {})}
教室: ${rows}行 × ${cols}列`;

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
                    { role: 'user', content: userContent }
                ],
                temperature: 0.2,
                max_tokens: 2048,
                response_format: { type: "json_object" }
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `API Error: ${response.status}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '{}';
        
        let result;
        try {
            result = JSON.parse(content);
        } catch (e) {
            throw new Error('AI 返回格式错误，请重试');
        }

        // ========== 一致性校验 ==========
        const inputIds = students.map(s => s.id).sort();
        const outputIds = (result.layout || [])
            .flat()
            .filter(id => id && id !== '_aisle_' && id !== null)
            .sort();

        if (JSON.stringify(inputIds) !== JSON.stringify(outputIds)) {
            console.warn('[Seating/Plan] 一致性校验失败 (Auto-Repairing):', { inputIds, outputIds });
            
            // 1. 找出缺失的学生ID
            const missingIds = inputIds.filter(id => !outputIds.includes(id));
            
            // 2. 找出重复的学生ID (仅保留第一个出现的)
            const seenIds = new Set();
            const duplicateLocations = []; // {r, c, id}
            
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const id = result.layout[r][c];
                    if (id && id !== '_aisle_') {
                        if (seenIds.has(id)) {
                            duplicateLocations.push({ r, c, id });
                            result.layout[r][c] = null; // 暂时清空重复位置
                        } else {
                            seenIds.add(id);
                        }
                    }
                }
            }

            // 3. 填补缺失的学生到空位 (包括刚刚清空的重复位)
            let missingIndex = 0;
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    if (missingIndex >= missingIds.length) break;
                    
                    const cell = result.layout[r][c];
                    // 如果是空位且不是过道
                    if (cell === null && !aisles.includes(c)) {
                        result.layout[r][c] = missingIds[missingIndex++];
                    }
                }
            }
            
            // 4. 如果还有没填进去的 (理论上不应发生，因 totalSeats >= studentCount)，添加到 unsatisfactory
            if (missingIndex < missingIds.length) {
                console.error('Auto-repair failed: Not enough seats for missing students');
                // Fallback: Still return success but warn? Or fail? 
                // Given pre-check, this implies logic error. Let's return best effort.
            }
        }

        res.json({
            success: true,
            data: {
                layout: result.layout,
                stats: result.stats || {},
                unsatisfied: result.unsatisfied || []
            }
        });

    } catch (error) {
        console.error('[Tools/Seating/Plan] Error:', error);
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
            return res.status(400).json({ 
                success: false, 
                error: '请提供学生名单文本' 
            });
        }

        // 尝试多种分割方式
        const lines = text.trim().split(/[\n\r]+/).filter(line => line.trim());
        const students = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // 尝试 Tab 分割 (Excel)
            let parts = line.split(/\t+/);
            if (parts.length === 1) {
                // 尝试多空格分割
                parts = line.split(/\s{2,}/);
            }
            if (parts.length === 1) {
                // 尝试逗号分割
                parts = line.split(/[,，]/);
            }

            const name = parts[0]?.trim();
            if (!name) continue;

            const student = {
                id: `s${String(i + 1).padStart(3, '0')}`,
                name: name
            };

            // 识别性别
            if (parts.length > 1) {
                const genderPart = parts[1]?.trim();
                if (/男|M|male/i.test(genderPart)) student.gender = 'M';
                else if (/女|F|female/i.test(genderPart)) student.gender = 'F';
            }

            // 识别成绩
            if (parts.length > 2) {
                const grade = parseFloat(parts[2]);
                if (!isNaN(grade)) student.grade = grade;
            }

            students.push(student);
        }

        res.json({
            success: true,
            data: {
                students,
                count: students.length,
                hasGender: students.some(s => s.gender),
                hasGrade: students.some(s => s.grade !== undefined)
            }
        });

    } catch (error) {
        console.error('[Tools/Seating/ParseStudents] Error:', error);
        res.status(500).json({ success: false, error: error.message });
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
