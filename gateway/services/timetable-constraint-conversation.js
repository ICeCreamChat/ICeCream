/**
 * 智能约束对话优化管理器
 * 支持用户通过自然语言与AI讨论并优化排课约束
 */

/**
 * 约束解释器 - 将技术约束转为自然语言
 */
export function explainConstraintToUser(constraint, project = {}) {
    const { type, targetName, targetId, value, slots = [] } = constraint;

    const teacherMap = new Map((project.teachers || []).map(t => [t.id, t.name]));
    const classMap = new Map((project.classes || []).map(c => [c.id, c.className || c.name]));
    const subjectMap = new Map((project.subjects || []).map(s => [s.id, s.name]));

    const teacher = targetName || teacherMap.get(targetId) || '教师';
    const klass = targetName || classMap.get(targetId) || '班级';
    const subject = targetName || subjectMap.get(targetId) || '课程';

    const slotText = slots.length ? ` (${formatSlots(slots, project)})` : '';

    const explanations = {
        teacher_daily_limit: `${teacher}每天最多上${value}节课`,
        teacher_consecutive_limit: `${teacher}连续上课不超过${value}节`,
        teacher_unavailable: `${teacher}在${slotText}时段不可用`,
        class_unavailable: `${klass}在${slotText}时段不可用`,
        locked_slot: `${teacher}给${klass}上${subject}固定在${slotText}`,
        subject_morning: `${subject}优先安排在上午`,
        subject_preferred_periods: `${subject}优先安排在${slotText}`,
        subject_avoid_periods: `${subject}避开${slotText}时段`,
        subject_spread: `${subject}的课程要分散在不同天`,
        teacher_load_balance: `${teacher}的工作量要尽量均衡`,
        class_daily_balance: `${klass}每天的课程要均衡安排`,
    };

    return explanations[type] || `${type}约束`;
}

/**
 * 格式化时段为自然语言
 */
function formatSlots(slots, project) {
    const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const formatted = slots.map(slot => {
        const match = String(slot).match(/^(\d+)-(\d+)$/);
        if (!match) return slot;
        const day = Number(match[1]);
        const period = Number(match[2]);
        return `${weekdayNames[day - 1] || `周${day}`}第${period}节`;
    });
    return formatted.join('、');
}

/**
 * 约束对话管理器
 */
export class TimetableConstraintConversation {
    constructor() {
        this.history = [];
        this.constraints = [];
        this.project = {};
    }

    /**
     * 初始化对话
     */
    initialize(constraints, project) {
        this.constraints = constraints;
        this.project = project;
        this.history = [{
            role: 'assistant',
            content: this.generateWelcomeMessage(constraints, project)
        }];
    }

    /**
     * 生成欢迎消息
     */
    generateWelcomeMessage(constraints, project) {
        const count = constraints.length;
        const examples = constraints.slice(0, 3).map(c =>
            `• ${explainConstraintToUser(c, project)}`
        ).join('\n');

        return `我已经为您解析出${count}条排课约束：

${examples}
${count > 3 ? `\n...还有${count - 3}条约束\n` : ''}
您可以：
1. 用自然语言告诉我需要调整的地方，比如"张老师的课太多了"
2. 询问任何约束的含义，比如"为什么王老师不能上第一节？"
3. 说"可以了"完成优化

有什么需要调整的吗？`;
    }

    /**
     * 处理用户消息
     */
    async chat(userMessage, env, fetchImpl) {
        this.history.push({ role: 'user', content: userMessage });

        // 识别用户意图
        const intent = this.recognizeIntent(userMessage);

        let response;
        switch (intent.type) {
            case 'confirm':
                response = this.handleConfirm();
                break;
            case 'query':
                response = await this.handleQuery(userMessage, intent, env, fetchImpl);
                break;
            case 'modify':
                response = await this.handleModify(userMessage, intent, env, fetchImpl);
                break;
            case 'delete':
                response = await this.handleDelete(userMessage, intent, env, fetchImpl);
                break;
            default:
                response = await this.handleGeneral(userMessage, env, fetchImpl);
        }

        this.history.push({ role: 'assistant', content: response.message });

        return {
            message: response.message,
            constraints: this.constraints,
            suggestedActions: response.actions || [],
            completed: intent.type === 'confirm'
        };
    }

    /**
     * 识别用户意图（增强版）
     */
    recognizeIntent(message) {
        const lower = message.toLowerCase();

        // 优先级匹配：精确模式
        const patterns = [
            { regex: /^(可以了|确认|没问题|就这样吧?)$/, type: 'confirm', confidence: 0.95 },
            { regex: /为什么.+(不能|不可以|要)/, type: 'query', confidence: 0.9 },
            { regex: /(删除|取消).+(约束|规则)/, type: 'delete', confidence: 0.9 },
            { regex: /(改成|调整|修改).+/, type: 'modify', confidence: 0.85 },
            // 模糊模式
            { regex: /(好|行|OK)/i, type: 'confirm', confidence: 0.7 },
            { regex: /\?$/, type: 'query', confidence: 0.6 },
            { regex: /(删除|去掉|移除|不要)/, type: 'delete', confidence: 0.7 },
            { regex: /(能不能|可以|帮我)/, type: 'modify', confidence: 0.6 },
        ];

        // 多模式匹配，返回最高置信度
        let bestMatch = { type: 'general', confidence: 0.5 };
        for (const pattern of patterns) {
            if (pattern.regex.test(lower)) {
                if (pattern.confidence > bestMatch.confidence) {
                    bestMatch = { type: pattern.type, confidence: pattern.confidence };
                }
            }
        }

        // 实体提取
        const entities = this.extractEntities(message);
        return { ...bestMatch, entities };
    }

    /**
     * 提取实体（新增）
     */
    extractEntities(message) {
        const entities = {
            teachers: [],
            classes: [],
            subjects: [],
            numbers: []
        };

        // 提取教师名称
        (this.project.teachers || []).forEach(t => {
            if (message.includes(t.name)) {
                entities.teachers.push({ id: t.id, name: t.name });
            }
        });

        // 提取班级
        (this.project.classes || []).forEach(c => {
            const className = c.className || c.name;
            if (className && message.includes(className)) {
                entities.classes.push({ id: c.id, name: className });
            }
        });

        // 提取课程
        (this.project.subjects || []).forEach(s => {
            if (s.name && message.includes(s.name)) {
                entities.subjects.push({ id: s.id, name: s.name });
            }
        });

        // 提取数字（用于限制调整）
        const numbers = message.match(/\d+/g);
        if (numbers) entities.numbers = numbers.map(Number);

        return entities;
    }

    /**
     * 处理确认
     */
    handleConfirm() {
        return {
            message: `好的！约束优化完成。共有${this.constraints.length}条约束已生效。\n\n您可以点击"确认导入"将这些约束应用到排课系统。`,
            actions: []
        };
    }

    /**
     * 处理询问
     */
    async handleQuery(message, intent, env, fetchImpl) {
        // 使用AI理解并回答
        const aiResponse = await this.callAI({
            instruction: '用户在询问约束的含义。请用通俗易懂的语言解释。',
            userMessage: message,
            constraints: this.constraints,
            project: this.project
        }, env, fetchImpl);

        return {
            message: aiResponse,
            actions: []
        };
    }

    /**
     * 处理修改
     */
    async handleModify(message, intent, env, fetchImpl) {
        // 使用AI理解修改意图并生成建议
        const aiResponse = await this.callAI({
            instruction: `用户想要修改约束。请：
1. 理解用户想修改什么
2. 提出具体的修改建议（用JSON格式）
3. 询问用户确认

返回格式：
{
  "explanation": "我理解您想...",
  "suggestion": "建议将...",
  "action": {
    "type": "modify",
    "targetConstraintIndex": 0,
    "changes": {...}
  }
}`,
            userMessage: message,
            constraints: this.constraints,
            project: this.project
        }, env, fetchImpl);

        // 解析AI响应并执行修改
        try {
            const parsed = JSON.parse(aiResponse);
            if (parsed.action && message.includes('确认')) {
                this.applyModification(parsed.action);
                return {
                    message: `✅ ${parsed.explanation}\n\n${parsed.suggestion}\n\n已应用修改。还需要其他调整吗？`,
                    actions: []
                };
            }
            return {
                message: `${parsed.explanation}\n\n${parsed.suggestion}\n\n回复"确认"来应用这个修改。`,
                actions: [parsed.action]
            };
        } catch (e) {
            return {
                message: aiResponse,
                actions: []
            };
        }
    }

    /**
     * 处理删除
     */
    async handleDelete(message, intent, env, fetchImpl) {
        const aiResponse = await this.callAI({
            instruction: '用户想删除某个约束。请识别是哪个约束，并询问确认。',
            userMessage: message,
            constraints: this.constraints,
            project: this.project
        }, env, fetchImpl);

        return {
            message: aiResponse,
            actions: []
        };
    }

    /**
     * 处理通用消息
     */
    async handleGeneral(message, env, fetchImpl) {
        const aiResponse = await this.callAI({
            instruction: '理解用户的需求，提供帮助。',
            userMessage: message,
            constraints: this.constraints,
            project: this.project
        }, env, fetchImpl);

        return {
            message: aiResponse,
            actions: []
        };
    }

    /**
     * 应用修改
     */
    applyModification(action) {
        if (action.type === 'modify' && action.targetConstraintIndex !== undefined) {
            const index = action.targetConstraintIndex;
            if (this.constraints[index]) {
                this.constraints[index] = {
                    ...this.constraints[index],
                    ...action.changes
                };
            }
        }
    }

    /**
     * 调用AI（增强版：超时控制+错误恢复）
     */
    async callAI({ instruction, userMessage, constraints, project }, env, fetchImpl) {
        const apiKey = env.AI_API_KEY;
        const baseUrl = env.AI_BASE_URL || 'https://api.anthropic.com';

        if (!apiKey) {
            return this.fallbackResponse(userMessage, instruction);
        }

        const constraintList = constraints.map((c, i) =>
            `${i + 1}. ${explainConstraintToUser(c, project)}`
        ).join('\n');

        const systemPrompt = `你是ICeCream排课系统的智能助手。帮助用户理解和优化排课约束。

当前约束：
${constraintList}

教师：${(project.teachers || []).map(t => t.name).join('、')}
班级：${(project.classes || []).map(c => c.className || c.name).join('、')}
课程：${(project.subjects || []).map(s => s.name).join('、')}

${instruction}`;

        const messages = [
            ...this.history.slice(-5), // 只保留最近5轮对话
            { role: 'user', content: userMessage }
        ];

        // 超时控制
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15秒超时

        try {
            const fetch = fetchImpl || globalThis.fetch;
            const response = await fetch(`${baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-3-5-sonnet-20241022',
                    max_tokens: 1024,
                    system: systemPrompt,
                    messages
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const data = await response.json();
            return data.content?.[0]?.text || '抱歉，AI暂时无法响应。';

        } catch (error) {
            clearTimeout(timeoutId);

            if (error.name === 'AbortError') {
                console.error('AI request timeout');
                return '⏱️ AI响应超时。您可以：\n1. 简化您的问题后重试\n2. 直接在表格中编辑约束';
            }

            console.error('AI call failed:', error);

            // 降级到规则响应
            return this.fallbackResponse(userMessage, instruction);
        }
    }

    /**
     * 降级响应（新增）
     */
    fallbackResponse(userMessage, instruction) {
        const lower = userMessage.toLowerCase();

        // 基于规则的简单响应
        if (/为什么/.test(lower)) {
            return '抱歉，AI服务暂时不可用。您可以在约束列表中查看每条约束的详细说明。';
        }

        if (/(修改|调整|改成)/.test(lower)) {
            const entities = this.extractEntities(userMessage);
            if (entities.teachers.length > 0) {
                return `我理解您想调整${entities.teachers[0].name}的约束。\n\n由于AI服务暂时不可用，请在下方约束表格中直接编辑。`;
            }
            return '请在下方约束表格中直接编辑您想修改的内容。';
        }

        if (/(删除|去掉)/.test(lower)) {
            return '请在下方约束表格中找到对应的约束，点击删除按钮即可移除。';
        }

        return '抱歉，AI服务暂时不可用。您可以：\n1. 稍后重试\n2. 手动编辑约束表格\n3. 联系技术支持';
    }
}
