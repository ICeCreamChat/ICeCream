const ACTIVITY_TYPE_DEFINITIONS = [
    { value: '普通课', key: 'normal', aliases: ['普通', '常规', 'normal', 'ordinary'] },
    { value: '实验课', key: 'lab', aliases: ['实验', 'lab', 'experiment'] },
    { value: '上机课', key: 'computer_lesson', aliases: ['上机', 'computerlesson', 'computerclass'] },
    { value: '新授课', key: 'new_lesson', aliases: ['新授', 'newlesson'] },
    { value: '复习', key: 'review', aliases: ['复习', 'review'] },
    { value: '答疑', key: 'q_and_a', aliases: ['答疑', 'qanda', 'tutorial'] },
    { value: '社团', key: 'club', aliases: ['社团', 'club'] },
];

const RESOURCE_TYPE_DEFINITIONS = [
    { value: '普通教室', key: 'ordinary_classroom', aliases: ['普通教室', 'ordinaryclassroom', 'ordinary'] },
    { value: '实验室', key: 'lab', aliases: ['实验室', '实验', 'lab'] },
    { value: '计算机教室', key: 'computer_room', aliases: ['计算机教室', '计算机', '机房', '电脑房', 'computerroom', 'computer'] },
];

export const TIMETABLE_ACTIVITY_TYPE_OPTIONS = ACTIVITY_TYPE_DEFINITIONS.map(({ value }) => ({ value, label: value }));
export const TIMETABLE_RESOURCE_TYPE_OPTIONS = RESOURCE_TYPE_DEFINITIONS.map(({ value }) => ({ value, label: value }));

function compact(value) {
    return String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function activityLookupKey(value) {
    return compact(value).replace(/课程?$/u, '');
}

function definitionFor(value, definitions, keyFor = compact) {
    const key = keyFor(value);
    if (!key) return null;
    return definitions.find(definition => (
        key === compact(definition.key)
        || definition.aliases.some(alias => key === compact(alias))
    )) || null;
}

function activityDefinitionFor(value) {
    const key = activityLookupKey(value);
    if (/实验|lab|experiment/u.test(key)) return ACTIVITY_TYPE_DEFINITIONS.find(item => item.key === 'lab');
    if (/新授|newlesson/u.test(key)) return ACTIVITY_TYPE_DEFINITIONS.find(item => item.key === 'new_lesson');
    if (/答疑|qanda|tutorial/u.test(key)) return ACTIVITY_TYPE_DEFINITIONS.find(item => item.key === 'q_and_a');
    if (/社团|club/u.test(key)) return ACTIVITY_TYPE_DEFINITIONS.find(item => item.key === 'club');
    if (/复习|review/u.test(key)) return ACTIVITY_TYPE_DEFINITIONS.find(item => item.key === 'review');
    return definitionFor(value, ACTIVITY_TYPE_DEFINITIONS, activityLookupKey);
}

function resourceDefinitionFor(value) {
    const key = compact(value);
    if (/机房|电脑房|计算机|computer/u.test(key)) return RESOURCE_TYPE_DEFINITIONS.find(item => item.key === 'computer_room');
    if (/实验|lab/u.test(key)) return RESOURCE_TYPE_DEFINITIONS.find(item => item.key === 'lab');
    if (/普通教室|ordinary/u.test(key)) return RESOURCE_TYPE_DEFINITIONS.find(item => item.key === 'ordinary_classroom');
    return definitionFor(value, RESOURCE_TYPE_DEFINITIONS);
}

export function timetableActivityTypeKey(value) {
    const definition = activityDefinitionFor(value);
    return definition?.key || activityLookupKey(value);
}

export function timetableResourceTypeKey(value) {
    const definition = resourceDefinitionFor(value);
    return definition?.key || compact(value);
}

function splitValues(value) {
    const raw = Array.isArray(value) ? value : [value];
    return raw.flatMap(item => String(item ?? '').split(/[,，、/;；|]+/u))
        .map(item => item.trim())
        .filter(Boolean);
}

function normalizeLabels(value, definitionForValue) {
    const labels = [];
    for (const item of splitValues(value)) {
        const definition = definitionForValue(item);
        const label = definition?.value || item;
        if (!labels.includes(label)) labels.push(label);
    }
    return labels;
}

export function normalizeTimetableActivityTypes(value) {
    return normalizeLabels(value, activityDefinitionFor);
}

export function normalizeTimetableResourceTypes(value) {
    return normalizeLabels(value, resourceDefinitionFor);
}
