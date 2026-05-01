const DEFAULT_ARRANGE_SUGGESTIONS = [
    '两人一组，中间留过道，讲台旁安排左右护法，护法位置要一个成绩较差一个成绩较好的',
    '按身高从前到后安排，视力不好的同学优先坐前排',
    '成绩强弱搭配，同桌尽量互补，爱讲话的同学不要相邻',
    '小组长均匀分布在教室各区域，男女尽量搭配均衡',
    '考试模式单人单座，中间和两侧都留出过道',
];

const DEFAULT_CHAT_SUGGESTIONS = [
    '帮我检查一下现在的座位有没有明显问题',
    '把成绩较弱的同学分散开',
    '把视力不好的同学尽量往前调整',
    '把爱讲话的同学分开一点',
    '帮我把同桌搭配调整得更均衡',
];

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function clampCount(value) {
    const count = Number(value);
    if (!Number.isInteger(count)) return 5;
    return Math.min(Math.max(count, 1), 8);
}

function summarizeStudents(students = []) {
    const list = asArray(students);
    const withGrade = list.filter(student => Number.isFinite(Number(student?.grade))).length;
    const withHeight = list.filter(student => Number.isFinite(Number(student?.height))).length;
    const male = list.filter(student => student?.gender === 'M').length;
    const female = list.filter(student => student?.gender === 'F').length;
    return {
        count: list.length,
        withGrade,
        withHeight,
        male,
        female,
        sampleNames: list.slice(0, 12).map(student => student?.name).filter(Boolean),
    };
}

function hasPlacedStudents(layout = []) {
    return asArray(layout).some(row => asArray(row).some(value => value && value !== '_aisle_'));
}

export function normalizeSuggestionRequest(body = {}) {
    const target = body.target === 'chat' ? 'chat' : 'arrange';
    return {
        target,
        text: String(body.text ?? '').trim(),
        students: asArray(body.students),
        constraints: asArray(body.constraints),
        strategy: body.strategy && typeof body.strategy === 'object' ? body.strategy : {},
        layout: asArray(body.layout),
        rows: Number.isInteger(Number(body.rows)) ? Number(body.rows) : undefined,
        cols: Number.isInteger(Number(body.cols)) ? Number(body.cols) : undefined,
        history: asArray(body.history).slice(-8),
        count: clampCount(body.count),
    };
}

export function fallbackSeatingSuggestions(request = {}) {
    const target = request.target === 'chat' ? 'chat' : 'arrange';
    const base = target === 'chat' ? DEFAULT_CHAT_SUGGESTIONS : DEFAULT_ARRANGE_SUGGESTIONS;
    const suggestions = [...base];

    if (target === 'chat' && !hasPlacedStudents(request.layout)) {
        suggestions.unshift('先帮我按当前要求生成一版座位表');
    }

    if (target === 'arrange' && request.students?.length >= 40) {
        suggestions.unshift('两人一组，中间留过道，讲台旁安排左右护法，护法位置要一个成绩较差一个成绩较好的');
    }

    return normalizeSuggestions(suggestions, request.count);
}

export function normalizeSuggestions(value, count = 5) {
    const source = Array.isArray(value)
        ? value
        : Array.isArray(value?.suggestions)
            ? value.suggestions
            : [];
    const seen = new Set();
    const normalized = [];

    for (const item of source) {
        const text = String(item ?? '').replace(/^试试[:：]\s*/, '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        normalized.push(text.length > 80 ? text.slice(0, 80) : text);
        if (normalized.length >= clampCount(count)) break;
    }

    return normalized;
}

export function parseSuggestionContent(content = '', count = 5) {
    const text = String(content || '').trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    if (!text) return [];

    try {
        return normalizeSuggestions(JSON.parse(text), count);
    } catch {
        const arrayMatch = text.match(/\[[\s\S]*\]/);
        if (!arrayMatch) return [];
        try {
            return normalizeSuggestions(JSON.parse(arrayMatch[0]), count);
        } catch {
            return [];
        }
    }
}

export function buildSeatingSuggestionMessages(request = {}) {
    const summary = summarizeStudents(request.students);
    const placed = hasPlacedStudents(request.layout);
    const targetLabel = request.target === 'chat' ? 'AI 座位助手聊天输入框' : '排座要求输入框';
    const task = request.target === 'chat'
        ? '生成老师可以直接发给座位助手的聊天指令，用于检查、换座、微调或补充排座需求。'
        : '生成老师可以直接填入排座要求框的完整排座要求。';
    const chatGuidance = request.target === 'chat'
        ? placed
            ? '当前已有座位表，只推荐当前布局内的微调，如检查问题、换座、移动、分开、靠近、往前/往后；不要主动推荐“重新生成、改布局、整班重排”等大改指令，除非 currentText 已经明显是在写大改需求。'
            : '当前还没有已生成座位表，建议要偏向生成整体排座或调整整体排座规则。'
        : '建议要像老师写给排座系统的完整需求，能直接用于生成整张座位表。';

    const payload = {
        target: request.target,
        currentText: request.text,
        studentSummary: summary,
        constraints: request.constraints,
        strategy: request.strategy,
        room: { rows: request.rows, cols: request.cols, hasPlacedStudents: placed },
        recentChat: request.history,
    };

    const system = `你是教师排座工具的智能提示生成器。${task}

要求：
1. 只返回 JSON：{"suggestions":["建议1","建议2"]}
2. 返回 ${request.count} 条中文建议，每条不超过 60 个汉字
3. 建议必须具体、可直接使用，不要解释
4. currentText 非空时，每条建议都必须优先作为 currentText 的自然补全，保留用户已输入的意思，不要给无关泛泛推荐
5. 不要包含“试试：”前缀
6. ${chatGuidance}
7. 面向位置：${targetLabel}`;

    return [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload, null, 2) },
    ];
}

export async function generateSeatingSuggestions({
    request,
    fetchImpl = fetch,
    env = process.env,
} = {}) {
    const normalized = normalizeSuggestionRequest(request);
    const fallback = fallbackSeatingSuggestions(normalized);

    try {
        const response = await fetchImpl(`${env.DEEPSEEK_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
            },
            body: JSON.stringify({
                model: env.DEEPSEEK_CHAT_MODEL || env.DEEPSEEK_MODEL || 'deepseek-chat',
                messages: buildSeatingSuggestionMessages(normalized),
                temperature: 0.8,
                max_tokens: 500,
                response_format: { type: 'json_object' },
            }),
            signal: AbortSignal.timeout(20000),
        });

        if (!response.ok) throw new Error(`AI suggestions failed: ${response.status}`);
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';
        const suggestions = parseSuggestionContent(content, normalized.count);
        return suggestions.length ? suggestions : fallback;
    } catch {
        return fallback;
    }
}
