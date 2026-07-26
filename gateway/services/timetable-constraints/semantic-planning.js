const AI_MODES = new Set(['targeted', 'all', 'off']);

function text(value = '', max = 4000) {
    return String(value ?? '').trim().slice(0, max);
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    return [value];
}

function enabledFlag(value = '') {
    return ['1', 'true', 'yes', 'on'].includes(text(value, 20).toLowerCase());
}

function disabledFlag(value = '') {
    return ['0', 'false', 'no', 'off'].includes(text(value, 20).toLowerCase());
}

export function resolveSemanticAiMode(env = {}) {
    const explicit = text(env.TIMETABLE_RULE_AI_MODE, 20).toLowerCase();
    if (AI_MODES.has(explicit)) return explicit;
    const legacy = text(env.TIMETABLE_RULE_AI_EXTRACT, 20).toLowerCase();
    if (enabledFlag(legacy)) return 'all';
    if (disabledFlag(legacy)) return 'off';
    return text(env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY, 1000) ? 'targeted' : 'off';
}

const COMPLEX_LANGUAGE_PATTERNS = [
    /(?:尤其是|特别是|重点是|更优先)/,
    /(?:也|同时|并且|而且|另外).{0,20}(?:尽量|优先|不要|不能|避免|不排)/,
    /(?:每周|每星期).{0,16}(?:至少|最少|不少于|\d+\s*次|[一二三四五六七八九十]+次)/,
    /(?:不要|避免|尽量不).{0,16}(?:集中|扎堆|挤在)/,
    /(?:任课|科任|授课)?(?:老师|教师).{0,16}(?:覆盖|任教|所教|所带).{0,8}(?:班级|班)/,
    /(?:方便|以便|避免|防止|考虑到|为了).{2,}/,
    /(?:除.+外|只有.+才|不是.+而是|不能都|不必都)/,
];

export function sourceNeedsSemanticPlanning(source = {}) {
    const rawText = text(source.rawText || source.source?.rawText, 4000);
    if (!rawText) return false;
    if (['ambiguous', 'partially_parsed', 'unrecognized'].includes(source.understandingStatus)) return true;
    if (['partially_executable', 'blocked_by_clarification'].includes(source.executionStatus)) return true;
    return COMPLEX_LANGUAGE_PATTERNS.some(pattern => pattern.test(rawText));
}

function relationParentId(clause = {}) {
    return text(clause.relation?.parentId || clause.relation?.parentClauseId, 300);
}

export function validateSemanticRelationGraph(sourceText = '', clauses = []) {
    const rawText = text(sourceText, 10000);
    const items = asArray(clauses).filter(item => item && typeof item === 'object');
    const ids = new Set(items.map(item => text(item.id, 300)).filter(Boolean));
    const errors = [];
    const parents = new Map();

    for (const clause of items) {
        const id = text(clause.id, 300);
        const evidence = text(clause.evidence?.quote || clause.evidence, 2000);
        const parentId = relationParentId(clause);
        if (!id) errors.push({ code: 'missing_clause_id', message: '语义 clause 缺少局部 ID。' });
        if (evidence && !rawText.includes(evidence)) {
            errors.push({ code: 'evidence_mismatch', clauseId: id, message: '语义证据不在当前来源原文中。' });
        }
        if (parentId && !ids.has(parentId)) {
            errors.push({ code: 'missing_relation_parent', clauseId: id, parentId, message: '语义关系引用了不存在的父 clause。' });
        }
        if (id && parentId) parents.set(id, parentId);
    }

    for (const id of ids) {
        const visiting = new Set();
        let current = id;
        while (parents.has(current)) {
            if (visiting.has(current)) {
                errors.push({ code: 'relation_cycle', clauseId: id, message: '语义关系不能形成循环。' });
                break;
            }
            visiting.add(current);
            current = parents.get(current);
        }
    }

    return { valid: errors.length === 0, errors };
}
