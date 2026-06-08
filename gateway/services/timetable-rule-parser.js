import {
    cleanText,
    normalizeTimetableProject,
} from './timetable-project.js';

export class TimetableRuleParseError extends Error {
    constructor(message, reason = 'ai_unavailable', status = 503) {
        super(message);
        this.name = 'TimetableRuleParseError';
        this.reason = reason;
        this.status = status;
    }
}

function cloneValue(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function normalizeBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function resolveAiConfig(env = {}) {
    const apiKey = String(env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || '').trim();
    const baseUrl = normalizeBaseUrl(env.DEEPSEEK_API_BASE || env.OPENAI_API_BASE || 'https://api.deepseek.com');
    const model = String(env.DEEPSEEK_MODEL || env.OPENAI_MODEL || 'deepseek-chat').trim();
    if (!apiKey) {
        throw new TimetableRuleParseError('AI 约束解析未配置，请先配置 DeepSeek API Key。', 'ai_not_configured', 503);
    }
    return { apiKey, baseUrl, model };
}

function resolveFetch(fetchImpl) {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    throw new TimetableRuleParseError('当前环境没有可用的 fetch，无法调用 AI 解析。', 'missing_fetch', 503);
}

function normalizeSlotList(values = []) {
    const raw = Array.isArray(values) ? values : [values];
    const result = [];
    for (const value of raw) {
        if (typeof value === 'string' && /^\d{1,2}-\d{1,2}$/.test(value.trim())) {
            const [day, period] = value.trim().split('-').map(item => Number.parseInt(item, 10));
            result.push(`${day}-${period}`);
        } else if (value && Number.isInteger(Number(value.day)) && Number.isInteger(Number(value.period))) {
            result.push(`${Number(value.day)}-${Number(value.period)}`);
        }
    }
    return [...new Set(result)];
}

function findEntity(items, constraint, keys) {
    const candidates = keys
        .flatMap(key => [constraint[key], constraint[`${key}Id`], constraint[`${key}Name`]])
        .map(value => cleanText(value, 80))
        .filter(Boolean);
    for (const candidate of candidates) {
        const found = items.find(item => (
            item.id === candidate
            || item.name === candidate
            || cleanText(`${item.grade || ''}${item.name || ''}`, 80) === candidate
        ));
        if (found) return found;
    }
    return null;
}

function addSlots(map, id, slots) {
    if (!id || !slots.length) return;
    map[id] = [...new Set([...(map[id] || []), ...slots])].sort();
}

function addMorningSubject(rules, subjectId) {
    if (!subjectId) return;
    const current = rules.softRules.morningSubjects || [];
    if (!current.includes(subjectId)) current.push(subjectId);
    rules.softRules.morningSubjects = current;
}

function previewItem({ index, type, target, slots = [], priority = 'hard', description = '', status = 'ready' }) {
    return {
        id: `draft_${index + 1}`,
        type,
        targetId: target?.id || '',
        targetName: target?.grade ? `${target.grade}${target.name}` : target?.name || '',
        slots,
        priority,
        description,
        status,
    };
}

function applyConstraint({ constraint, project, rules, warnings, index }) {
    const type = String(constraint.type || constraint.ruleType || '').trim().toLowerCase().replace(/-/g, '_');
    const priority = constraint.priority === 'soft' ? 'soft' : 'hard';
    const description = cleanText(constraint.reason || constraint.description || constraint.note || '', 140);
    const slots = normalizeSlotList(constraint.slots || constraint.slotKeys || constraint.times || constraint.periods);

    if (['teacher_unavailable', 'teacherunavailable'].includes(type)) {
        const teacher = findEntity(project.teachers, constraint, ['teacher', 'target']);
        if (!teacher || !slots.length) {
            warnings.push(`第 ${index + 1} 条教师不可排规则缺少教师或节次，已跳过。`);
            return null;
        }
        addSlots(rules.hardRules.teacherUnavailable, teacher.id, slots);
        return previewItem({ index, type: 'teacher_unavailable', target: teacher, slots, priority: 'hard', description });
    }

    if (['class_unavailable', 'classunavailable'].includes(type)) {
        const klass = findEntity(project.classes, constraint, ['class', 'target']);
        if (!klass || !slots.length) {
            warnings.push(`第 ${index + 1} 条班级不可排规则缺少班级或节次，已跳过。`);
            return null;
        }
        addSlots(rules.hardRules.classUnavailable, klass.id, slots);
        return previewItem({ index, type: 'class_unavailable', target: klass, slots, priority: 'hard', description });
    }

    if (['subject_morning', 'morning_subject', 'subject_prefer_morning'].includes(type)) {
        const subject = findEntity(project.subjects, constraint, ['subject', 'target']);
        if (!subject) {
            warnings.push(`第 ${index + 1} 条课程上午优先规则缺少课程，已跳过。`);
            return null;
        }
        addMorningSubject(rules, subject.id);
        return previewItem({ index, type: 'subject_morning', target: subject, slots, priority: 'soft', description });
    }

    warnings.push(`暂不支持 "${constraint.type || 'unknown'}" 规则类型，已跳过。`);
    return null;
}

function normalizeAiContent(content) {
    if (typeof content === 'object' && content) return content;
    const text = String(content || '').trim();
    if (!text) return {};
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    return JSON.parse(fenced ? fenced[1] : text);
}

function buildPrompt(project, text) {
    return [
        {
            role: 'system',
            content: [
                'You convert Chinese school timetable requests into strict JSON.',
                'Return only JSON: {"constraints":[...]}',
                'Supported types: teacher_unavailable, class_unavailable, subject_morning.',
                'Use targetId whenever possible. Slots use "day-period", for example "3-4".',
            ].join('\n'),
        },
        {
            role: 'user',
            content: JSON.stringify({
                request: text,
                teachers: project.teachers.map(({ id, name }) => ({ id, name })),
                classes: project.classes.map(({ id, grade, name }) => ({ id, name: `${grade}${name}` })),
                subjects: project.subjects.map(({ id, name }) => ({ id, name })),
                activeWeekdays: project.activeWeekdays,
                activePeriods: project.activePeriods,
            }),
        },
    ];
}

export async function parseTimetableRules({
    text = '',
    project: inputProject = {},
    env = process.env,
    fetchImpl,
} = {}) {
    const prompt = cleanText(text, 2000);
    if (!prompt) {
        throw new TimetableRuleParseError('请先输入要解析的排课约束。', 'empty_prompt', 400);
    }

    const project = normalizeTimetableProject(inputProject);
    const rules = cloneValue(project.rules);
    rules.hardRules = rules.hardRules || {};
    rules.hardRules.teacherUnavailable = { ...(rules.hardRules.teacherUnavailable || {}) };
    rules.hardRules.classUnavailable = { ...(rules.hardRules.classUnavailable || {}) };
    rules.hardRules.lockedSlots = [...(rules.hardRules.lockedSlots || [])];
    rules.softRules = rules.softRules || {};
    rules.softRules.morningSubjects = [...(rules.softRules.morningSubjects || [])];

    const { apiKey, baseUrl, model } = resolveAiConfig(env);
    const fetchClient = resolveFetch(fetchImpl);
    const response = await fetchClient(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            temperature: 0.1,
            response_format: { type: 'json_object' },
            messages: buildPrompt(project, prompt),
        }),
    });
    const raw = await response.text();
    let payload = {};
    try {
        payload = raw ? JSON.parse(raw) : {};
    } catch {
        throw new TimetableRuleParseError('AI 返回内容不是有效 JSON。', 'ai_invalid_json', 502);
    }
    if (!response.ok) {
        throw new TimetableRuleParseError(payload.error?.message || 'AI 约束解析失败。', 'ai_failed', response.status || 502);
    }

    const content = payload.choices?.[0]?.message?.content ?? payload;
    let parsed;
    try {
        parsed = normalizeAiContent(content);
    } catch {
        throw new TimetableRuleParseError('AI 解析结果不是有效 JSON。', 'ai_invalid_json', 502);
    }

    const constraints = Array.isArray(parsed.constraints) ? parsed.constraints : Array.isArray(parsed.rules) ? parsed.rules : [];
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(item => cleanText(item, 160)).filter(Boolean) : [];
    const previewItems = constraints
        .map((constraint, index) => applyConstraint({ constraint, project, rules, warnings, index }))
        .filter(Boolean);

    return {
        draftRules: normalizeTimetableProject({ ...project, rules }).rules,
        previewItems,
        warnings,
        source: 'ai',
    };
}
