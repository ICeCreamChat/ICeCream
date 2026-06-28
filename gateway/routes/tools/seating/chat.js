import express from 'express';
import fetch from 'node-fetch';
import {
    buildSeatingChatSnapshot,
    classifySeatingChatIntent,
    normalizeChatOperations,
    resolveEmptyMutationResponse,
} from '../../../services/seating-chat.js';

const router = express.Router();

// ================================
// Seating Chat - AI 座后辅助对话
// ================================

/**
 * POST /api/tools/seating/chat
 * AI-powered seat adjustment assistant
 */
router.post('/chat', async (req, res) => {
    try {
        const { message, history = [], layout, students, rows, cols, guardians = [], mode = '' } = req.body;
        if (!message) {
            return res.status(400).json({ success: false, error: '请提供消息' });
        }

        if (!layout || !students) {
            return res.status(400).json({ success: false, error: '请先生成座位表' });
        }

        const explicitMode = (mode === 'regenerate' || mode === 'micro') ? mode : '';
        const chatIntent = classifySeatingChatIntent(message, students, explicitMode);
        if (chatIntent.intent === 'regenerate') {
            return res.json({
                success: true,
                data: {
                    reply: '这是重新排座或布局规则调整，我会先请你确认。',
                    operations: [],
                    rejected: [],
                    mutationIntent: false,
                    needsAction: false,
                    warnings: [],
                    intent: chatIntent.intent,
                    requiresConfirmation: chatIntent.requiresConfirmation,
                    confirmationText: chatIntent.confirmationText,
                    arrangementPrompt: chatIntent.arrangementPrompt,
                }
            });
        }

        const studentList = students.map(s => `${s.name}(id:${s.id}, ${s.gender === 'M' ? '男' : s.gender === 'F' ? '女' : '未知'}, 成绩:${s.grade || '无'})`).join(', ');
        const seatingSnapshot = buildSeatingChatSnapshot({ layout, students, guardians });
        const seatingLines = seatingSnapshot.occupied.length
            ? seatingSnapshot.occupied.map(seat => {
                const label = seat.role === 'guardian'
                    ? (seat.side === 'left' ? '左护法' : '右护法')
                    : '座位';
                return `${seat.name}(id:${seat.id}) 在 ${label} row:${seat.row}, col:${seat.col}`;
            }).join('\n')
            : '当前没有已安排学生';
        const studentById = new Map(students.map(student => [student.id, student]));
        const guardianLines = [
            `左护法: ${guardians?.[0] ? `${studentById.get(guardians[0])?.name || guardians[0]}(id:${guardians[0]})` : '空'}`,
            `右护法: ${guardians?.[1] ? `${studentById.get(guardians[1])?.name || guardians[1]}(id:${guardians[1]})` : '空'}`,
        ].join('\n');

        const systemPrompt = `你是智能座位助手。老师已经生成了一个 ${rows}×${cols} 的座位表，现在需要你帮忙微调。

【当前座位表】(行号从0开始，_aisle_ 表示过道，null 表示空位)
${layout.map((row, i) => `第${i}行: ${row.map(c => c || '空').join(' | ')}`).join('\n')}

【当前学生坐标】
${seatingLines}

【当前左右护法】
${guardianLines}

【学生信息】
${studentList}

【你的职责】
1. 理解老师的自然语言指令
2. 回复简短友好的中文说明
3. 如果指令涉及座位调整，返回具体操作
4. 只能在现有布局内微调，不能改变教室结构、过道、座位容量，不能重新生成整张座位表
5. 当前已由后端判定为 ${chatIntent.intent}，必须按这个意图处理

【输出格式 (Strict JSON)】
{
  "reply": "给老师的回复文字",
  "operations": [
    {"type": "swap", "student1Id": "s01", "student2Id": "s02"},
    {"type": "move", "studentId": "s03", "row": 0, "col": 2},
    {"type": "set_guardian", "studentId": "s04", "side": "left"}
  ]
}

【规则】
- operations 数组可以为空（如仅分析/回答问题时）
- 你是当前座位表微调助手，只能在现有布局内微调；允许的执行动作只有 swap、move 和 set_guardian
- 所有 move 必须落在当前 rows/cols/aisles/classroomLayout 已存在的可坐位置内
- 护法位使用虚拟坐标：左护法 row:-1,col:0，右护法 row:-1,col:1；调整护法必须返回 set_guardian，不要返回 move 到 row:-1
- set_guardian = 把某个学生安排到左右护法位，side 只能是 "left" 或 "right"；被替换的原护法会回到该学生原座位
- 选择成绩档位时，"较好/比较好" 优先取上四分位附近而不是最高分，"较差/比较差" 优先取下四分位附近而不是最低分，"一般/中等/普通/平均" 取中位数附近；只有老师明确说最高/最好/最低/最差时才选极端
- direct_edit：老师要求换座、移动、前后左右挪、安排到某排某列或指定某人做护法时，必须返回 operations，不能只回复文字
- batch_tune：老师要求不改布局的批量微调，例如分散成绩弱同学、同桌更均衡、爱讲话同学分开、挑两个成绩较好的左右护法时，可以返回多条 swap/move/set_guardian；前端会先确认再执行
- explain：只做检查、分析或解释，operations 必须返回 []
- clarify：学生姓名或目标位置不明确，operations 必须返回 []，reply 只追问缺失信息
- regenerate：大改已经在进入 AI 前拦截；不要自行把改布局、改规则或重排全班拆成大量 move
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

        if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            throw new Error(errBody.error?.message || `AI API 返回 ${response.status}`);
        }

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
        const executableIntent = chatIntent.intent === 'direct_edit' || chatIntent.intent === 'batch_tune';
        const filteredOperations = executableIntent ? operations : [];
        const filteredRejected = executableIntent ? rejected : [];
        const emptyMutation = chatIntent.intent === 'direct_edit'
            ? resolveEmptyMutationResponse({ message, operations: filteredOperations, rejected: filteredRejected })
            : {
                mutationIntent: chatIntent.mutationIntent,
                needsAction: chatIntent.intent === 'clarify' || (chatIntent.intent === 'batch_tune' && filteredOperations.length === 0),
                rejected: filteredRejected,
                warnings: chatIntent.intent === 'clarify' ? ['请补充学生姓名或目标位置。'] : []
            };

        if (chatIntent.intent === 'batch_tune' && filteredOperations.length === 0 && emptyMutation.rejected.length === 0) {
            emptyMutation.rejected.push({ reason: 'AI 没有返回可确认执行的批量微调操作' });
        }

        res.json({
            success: true,
            data: {
                reply: parsed.reply || '好的',
                operations: filteredOperations,
                rejected: emptyMutation.rejected,
                mutationIntent: emptyMutation.mutationIntent,
                needsAction: emptyMutation.needsAction,
                warnings: emptyMutation.warnings,
                intent: chatIntent.intent,
                requiresConfirmation: chatIntent.requiresConfirmation,
                confirmationText: chatIntent.confirmationText,
                arrangementPrompt: chatIntent.arrangementPrompt,
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

export default router;
