function cloneValue(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function byId(items = []) {
    return new Map(items.map(item => [item.id, item]));
}

function itemName(item, fallback = '') {
    return item?.name || item?.className || item?.label || fallback;
}

function resolveName(map, id, fallback) {
    return itemName(map.get(id), fallback || id || '未指定对象');
}

export function explainConstraintToUser(constraint = {}, project = {}) {
    const teachers = byId(project.teachers || []);
    const classes = byId(project.classes || []);
    const subjects = byId(project.subjects || []);

    const teacher = constraint.targetName
        || resolveName(teachers, constraint.teacherId || constraint.targetId, '教师');
    const klass = constraint.className
        || resolveName(classes, constraint.classId || constraint.targetId, '班级');
    const subject = constraint.subjectName
        || resolveName(subjects, constraint.subjectId || constraint.targetId, '课程');
    const value = constraint.value ?? constraint.limit ?? '默认';
    const slotText = formatSlots(constraint.slots || constraint.periods || [], project);

    switch (constraint.type) {
        case 'teacher_daily_limit':
            return `${teacher} 每天最多上 ${value} 节课`;
        case 'teacher_consecutive_limit':
            return `${teacher} 连续上课不超过 ${value} 节`;
        case 'teacher_unavailable':
            return `${teacher} 在 ${slotText} 不可排课`;
        case 'class_unavailable':
            return `${klass} 在 ${slotText} 不可排课`;
        case 'locked_slot':
            return `${teacher} 给 ${klass} 上 ${subject}，固定在 ${slotText}`;
        case 'subject_morning':
            return `${subject} 优先安排在上午`;
        case 'subject_preferred_periods':
            return `${subject} 优先安排在 ${slotText}`;
        case 'subject_avoid_periods':
            return `${subject} 避开 ${slotText}`;
        case 'subject_spread':
            return `${subject} 尽量分散到不同日期`;
        case 'teacher_load_balance':
            return `${teacher} 的工作量尽量均衡`;
        case 'class_daily_balance':
            return `${klass} 每天的课程尽量均衡`;
        default:
            return constraint.description || constraint.rawText || `${constraint.type || '未知'} 约束`;
    }
}

export function formatSlots(slots = []) {
    if (!Array.isArray(slots) || !slots.length) return '指定时段';

    const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    return slots.map(slot => {
        if (typeof slot === 'object' && slot) {
            const day = Number(slot.day);
            const period = Number(slot.period);
            if (Number.isFinite(day) && Number.isFinite(period)) {
                return `${weekdayNames[day - 1] || `周${day}`}第 ${period} 节`;
            }
        }

        const match = String(slot).match(/^(\d+)-(\d+)$/);
        if (!match) return String(slot);

        const day = Number(match[1]);
        const period = Number(match[2]);
        return `${weekdayNames[day - 1] || `周${day}`}第 ${period} 节`;
    }).join('、');
}

export class TimetableConstraintConversation {
    constructor() {
        this.history = [];
        this.constraints = [];
        this.project = {};
    }

    initialize(constraints = [], project = {}) {
        if (!Array.isArray(constraints)) {
            throw new Error('constraints 必须是数组。');
        }

        this.constraints = cloneValue(constraints) || [];
        this.project = cloneValue(project) || {};
        this.history = [{
            role: 'assistant',
            content: this.generateWelcomeMessage(),
            timestamp: Date.now(),
        }];
    }

    generateWelcomeMessage() {
        const count = this.constraints.length;
        const examples = this.constraints
            .slice(0, 3)
            .map((constraint, index) => `${index + 1}. ${explainConstraintToUser(constraint, this.project)}`)
            .join('\n');

        return `我已经读取到 ${count} 条排课约束。\n\n${examples || '还没有可展示的约束。'}${count > 3 ? `\n还有 ${count - 3} 条约束可继续查看。` : ''}\n\n你可以让我解释约束、调整数值、删除不需要的规则，或回复“确认”完成优化。`;
    }

    async chat(userMessage, env = {}, fetchImpl = globalThis.fetch) {
        const message = String(userMessage || '').trim();
        if (!message) {
            throw new Error('message 不能为空。');
        }

        this.history.push({ role: 'user', content: message, timestamp: Date.now() });

        const intent = this.recognizeIntent(message);
        const response = await this.respond(message, intent, env, fetchImpl);

        this.history.push({
            role: 'assistant',
            content: response.message,
            timestamp: Date.now(),
        });

        return {
            message: response.message,
            constraints: this.constraints,
            suggestedActions: response.actions || [],
            completed: intent.type === 'confirm',
        };
    }

    recognizeIntent(message) {
        const normalized = message.trim().toLowerCase();
        const entities = this.extractEntities(message);

        if (/^(确认|可以|没问题|就这样|完成|好了|ok|okay|yes)$/i.test(normalized)) {
            return { type: 'confirm', confidence: 0.95, entities };
        }
        if (/(为什么|解释|含义|什么意思|怎么看|说明)/.test(normalized) || /[?？]$/.test(normalized)) {
            return { type: 'query', confidence: 0.85, entities };
        }
        if (/(删除|取消|移除|不要).*(约束|规则)?/.test(normalized)) {
            return { type: 'delete', confidence: 0.85, entities };
        }
        if (/(改成|调整|修改|最多|不超过|限制|换成|设为)/.test(normalized)) {
            return { type: 'modify', confidence: 0.8, entities };
        }

        return { type: 'general', confidence: 0.5, entities };
    }

    extractEntities(message) {
        const entities = {
            teachers: [],
            classes: [],
            subjects: [],
            numbers: [],
        };

        for (const teacher of this.project.teachers || []) {
            if (teacher.name && message.includes(teacher.name)) {
                entities.teachers.push({ id: teacher.id, name: teacher.name });
            }
        }

        for (const klass of this.project.classes || []) {
            const name = itemName(klass);
            if (name && message.includes(name)) {
                entities.classes.push({ id: klass.id, name });
            }
        }

        for (const subject of this.project.subjects || []) {
            if (subject.name && message.includes(subject.name)) {
                entities.subjects.push({ id: subject.id, name: subject.name });
            }
        }

        const numbers = message.match(/\d+/g);
        if (numbers) entities.numbers = numbers.map(Number);

        return entities;
    }

    async respond(message, intent, env, fetchImpl) {
        if (intent.type === 'confirm') {
            return {
                message: `好的，约束优化完成。当前共有 ${this.constraints.length} 条约束，可以确认生效。`,
            };
        }

        if (intent.type === 'modify') {
            const localResult = this.applySimpleModification(intent.entities);
            if (localResult) return localResult;
        }

        if (intent.type === 'delete') {
            const localResult = this.applySimpleDelete(intent.entities);
            if (localResult) return localResult;
        }

        const aiMessage = await this.callAI({
            instruction: this.instructionForIntent(intent.type),
            userMessage: message,
        }, env, fetchImpl);

        return { message: aiMessage };
    }

    instructionForIntent(intentType) {
        const instructions = {
            query: '用户在询问约束含义，请用简洁中文解释，并指出可能的排课影响。',
            modify: '用户想调整约束。请先说明理解到的修改目标，再给出建议；不要输出无法解析的 JSON。',
            delete: '用户想删除约束。请说明你识别到的目标，并提醒用户确认。',
            general: '用户正在讨论排课约束，请提供简洁、可执行的建议。',
        };
        return instructions[intentType] || instructions.general;
    }

    applySimpleModification(entities) {
        const teacher = entities.teachers[0];
        const value = entities.numbers[0];
        if (!teacher || !Number.isFinite(value)) return null;

        const index = this.constraints.findIndex(constraint => {
            const typeMatches = ['teacher_daily_limit', 'teacher_consecutive_limit'].includes(constraint.type);
            const targetMatches = constraint.targetId === teacher.id
                || constraint.teacherId === teacher.id
                || constraint.targetName === teacher.name;
            return typeMatches && targetMatches;
        });

        if (index < 0) return null;

        const previous = this.constraints[index];
        this.constraints[index] = {
            ...previous,
            value,
            description: `${teacher.name} 每天最多上 ${value} 节课`,
            status: previous.status === 'invalid' ? 'needs_review' : previous.status,
        };

        return {
            message: `已把 ${teacher.name} 的约束调整为最多 ${value} 节。请在复核表中确认后生效。`,
            actions: [{
                type: 'modify',
                targetConstraintId: previous.id,
                changes: { value },
            }],
        };
    }

    applySimpleDelete(entities) {
        const candidates = [
            ...entities.teachers,
            ...entities.classes,
            ...entities.subjects,
        ];
        if (!candidates.length) return null;

        const names = new Set(candidates.map(item => item.name));
        const ids = new Set(candidates.map(item => item.id));
        const before = this.constraints.length;
        this.constraints = this.constraints.filter(constraint => {
            return !ids.has(constraint.targetId)
                && !ids.has(constraint.teacherId)
                && !ids.has(constraint.classId)
                && !ids.has(constraint.subjectId)
                && !names.has(constraint.targetName)
                && !names.has(constraint.className)
                && !names.has(constraint.subjectName);
        });

        const removed = before - this.constraints.length;
        if (!removed) return null;

        return {
            message: `已移除 ${removed} 条相关约束，请复核后确认生效。`,
            actions: [{ type: 'delete', count: removed }],
        };
    }

    async callAI({ instruction, userMessage }, env = {}, fetchImpl = globalThis.fetch) {
        const apiKey = env.AI_API_KEY;
        const baseUrl = env.AI_BASE_URL || 'https://api.anthropic.com';
        const model = env.AI_MODEL || 'claude-3-5-sonnet-20241022';

        if (!apiKey || typeof fetchImpl !== 'function') {
            return this.fallbackResponse(userMessage);
        }

        const constraintList = this.constraints
            .map((constraint, index) => `${index + 1}. ${explainConstraintToUser(constraint, this.project)}`)
            .join('\n');

        const system = `你是 ICeCream 排课系统的约束优化助手。当前约束如下：\n${constraintList || '暂无约束'}\n\n${instruction}`;
        const messages = this.history
            .slice(-6)
            .filter(item => ['user', 'assistant'].includes(item.role))
            .map(item => ({ role: item.role, content: item.content }));

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        try {
            const response = await fetchImpl(`${baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model,
                    max_tokens: 900,
                    system,
                    messages,
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new Error(`AI request failed with status ${response.status}`);
            }

            const data = await response.json();
            return data.content?.[0]?.text || this.fallbackResponse(userMessage);
        } catch (error) {
            console.error('Constraint AI call failed:', error);
            return this.fallbackResponse(userMessage);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    fallbackResponse(userMessage) {
        const lower = String(userMessage || '').toLowerCase();
        if (/(为什么|解释|含义|什么意思|说明)/.test(lower) || /[?？]$/.test(lower)) {
            const examples = this.constraints
                .slice(0, 3)
                .map((constraint, index) => `${index + 1}. ${explainConstraintToUser(constraint, this.project)}`)
                .join('\n');
            return `这些约束会影响排课求解器的可选空间：\n\n${examples || '当前没有可解释的约束。'}\n\n如果某条约束过严，可能导致课表冲突或无法排满。`;
        }

        if (/(删除|取消|移除|不要)/.test(lower)) {
            return '我还没能精确定位要删除的约束。请在消息里带上教师、班级或课程名称，例如“删除王老师相关约束”。';
        }

        if (/(改成|调整|修改|最多|不超过|限制|换成|设为)/.test(lower)) {
            return '我还没能自动完成这次修改。可以写得更具体一些，例如“王老师每天最多 4 节”，也可以直接在复核表里编辑数值。';
        }

        return '我可以帮你解释、调整或删除当前约束。试着问“解释这些约束”，或说“王老师每天最多 4 节”。';
    }
}
