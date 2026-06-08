import path from 'node:path';

import AdmZip from 'adm-zip';

import {
    cleanText,
    getActivePeriods,
    getActiveWeekdays,
    normalizeTimetableProject,
    slotKey,
} from './timetable-project.js';
import {
    previewTimetableRosterFile,
} from './timetable-import.js';

const MAX_RULE_FILE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_EFFECTIVE_TYPES = new Set([
    'teacher_unavailable',
    'class_unavailable',
    'subject_morning',
    'subject_preferred_periods',
    'subject_avoid_periods',
]);
const SUGGESTION_ONLY_TYPES = new Set([
    'teacher_load_balance',
    'teacher_daily_limit',
    'teacher_consecutive_limit',
    'subject_spread',
    'quality_subject_later',
    'block_protection',
    'class_daily_balance',
    'class_subject_spread',
    'same_subject_spread',
]);

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

function asText(value, max = 4000) {
    return String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function normalizeBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function resolveAiConfig(env = {}) {
    const apiKey = String(env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || '').trim();
    const baseUrl = normalizeBaseUrl(env.DEEPSEEK_API_BASE || env.OPENAI_API_BASE || 'https://api.deepseek.com');
    const model = String(env.DEEPSEEK_MODEL || env.OPENAI_MODEL || env.DEEPSEEK_CHAT_MODEL || 'deepseek-chat').trim();
    if (!apiKey) {
        throw new TimetableRuleParseError('AI 约束解析未配置，请先配置 API Key。', 'ai_not_configured', 503);
    }
    return { apiKey, baseUrl, model };
}

function resolveFetch(fetchImpl) {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    throw new TimetableRuleParseError('当前环境没有可用 fetch，无法调用 AI 解析。', 'missing_fetch', 503);
}

function decodeXml(value = '') {
    return String(value)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function xmlAttrs(value = '') {
    return Object.fromEntries([...String(value).matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)].map(match => [match[1], match[2]]));
}

function readEntry(zip, name) {
    const entry = zip.getEntry(name);
    return entry ? zip.readAsText(entry, 'utf8') : '';
}

function parseSharedStrings(xml = '') {
    const values = [];
    for (const match of xml.matchAll(/<si[\s\S]*?<\/si>/g)) {
        const text = [...match[0].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
            .map(item => decodeXml(item[1]))
            .join('');
        values.push(asText(text, 400));
    }
    return values;
}

function columnIndex(ref = '') {
    const letters = String(ref).replace(/\d+/g, '');
    let index = 0;
    for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
    return index - 1;
}

function worksheetRows(xml = '', sharedStrings = []) {
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const row = [];
        for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
            const attrs = xmlAttrs(cellMatch[1]);
            const ref = attrs.r || 'A1';
            const cellXml = cellMatch[2];
            const value = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '';
            const inline = [...cellXml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(item => decodeXml(item[1])).join('');
            const text = attrs.t === 's' ? sharedStrings[Number(value)] : inline || value;
            row[columnIndex(ref)] = asText(text, 500);
        }
        if (row.some(Boolean)) rows.push(row.map(value => value || ''));
    }
    return rows;
}

function workbookSheets(file = {}) {
    if (!Buffer.isBuffer(file.buffer) || file.buffer.length <= 0) {
        throw new TimetableRuleParseError('上传的约束文件为空。', 'empty_file', 400);
    }
    if (file.buffer.length > MAX_RULE_FILE_BYTES) {
        throw new TimetableRuleParseError('约束文件不能超过 5MB。', 'file_too_large', 413);
    }
    const ext = path.extname(file.filename || '').toLowerCase();
    if (!['.xlsx', '.xls'].includes(ext)) {
        throw new TimetableRuleParseError('AI 约束文件只支持 .xlsx 或 .xls。', 'unsupported_file_type', 400);
    }

    const zip = new AdmZip(file.buffer);
    const sharedStrings = parseSharedStrings(readEntry(zip, 'xl/sharedStrings.xml'));
    const workbookXml = readEntry(zip, 'xl/workbook.xml');
    const relsXml = readEntry(zip, 'xl/_rels/workbook.xml.rels');
    const rels = {};
    for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
        const attrs = xmlAttrs(match[1]);
        if (attrs.Id && attrs.Target) rels[attrs.Id] = attrs.Target;
    }

    const sheets = [];
    for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
        const attrs = xmlAttrs(match[1]);
        const target = rels[attrs['r:id']];
        if (!target) continue;
        const entryName = target.startsWith('xl/') ? target : `xl/${target.replace(/^\/+/, '')}`;
        const normalized = entryName.includes('/worksheets/') ? entryName : `xl/${target}`;
        const xml = readEntry(zip, normalized);
        if (xml) sheets.push({ name: attrs.name || `Sheet${sheets.length + 1}`, rows: worksheetRows(xml, sharedStrings) });
    }

    if (!sheets.length) {
        for (const entry of zip.getEntries().filter(item => /^xl\/worksheets\/sheet\d+\.xml$/.test(item.entryName))) {
            sheets.push({
                name: `Sheet${sheets.length + 1}`,
                rows: worksheetRows(zip.readAsText(entry, 'utf8'), sharedStrings),
            });
        }
    }
    if (!sheets.length) throw new TimetableRuleParseError('Excel 文件里没有可读取的工作表。', 'empty_file', 400);
    return sheets;
}

function normalizeHeader(value) {
    const text = asText(value, 80).toLowerCase();
    if (/年级|grade/.test(text)) return 'grade';
    if (/班级|class/.test(text)) return 'className';
    if (/课程|科目|学科|subject|course/.test(text)) return 'subjectName';
    if (/教师|老师|teacher/.test(text)) return 'teacherName';
    if (/周课时|课时|hours|hour/.test(text)) return 'weeklyHours';
    if (/连堂|block/.test(text)) return 'blockPreference';
    if (/自然语言|约束描述|约束内容|constraint|request|prompt|natural/.test(text)) return 'constraintText';
    if (/约束名称|规则名称|rule name|name/.test(text)) return 'ruleName';
    if (/约束类型|类型|type/.test(text)) return 'ruleType';
    if (/对象|目标|target/.test(text)) return 'target';
    if (/周几|星期|weekday|day/.test(text)) return 'days';
    if (/节次|period|time/.test(text)) return 'periods';
    if (/slot|时间格/.test(text)) return 'slots';
    if (/强度|priority/.test(text)) return 'priority';
    if (/依据|原因|说明|备注|reason|note|description/.test(text)) return 'description';
    return null;
}

function classifyWorkbook(sheets = []) {
    let bestRoster = null;
    let bestConstraints = null;
    for (const sheet of sheets) {
        const header = (sheet.rows[0] || []).map(normalizeHeader);
        const rosterScore = ['className', 'subjectName', 'teacherName', 'weeklyHours']
            .filter(key => header.includes(key)).length;
        const constraintScore = ['constraintText', 'ruleName', 'ruleType', 'target', 'slots', 'periods']
            .filter(key => header.includes(key)).length;
        const nameLooksConstraint = /ai|约束|constraint|rules?|可复制/i.test(sheet.name || '');
        if (rosterScore >= 3 && (!bestRoster || rosterScore > bestRoster.score)) bestRoster = { sheet, header, score: rosterScore };
        if ((constraintScore >= 2 || nameLooksConstraint) && (!bestConstraints || constraintScore > bestConstraints.score)) {
            bestConstraints = { sheet, header, score: constraintScore };
        }
    }
    if (bestRoster && (!bestConstraints || bestRoster.score >= 4)) return { inputType: 'xlsx_roster', sheet: bestRoster.sheet };
    if (bestConstraints) return { inputType: 'xlsx_constraints', sheet: bestConstraints.sheet, header: bestConstraints.header };
    throw new TimetableRuleParseError('无法识别 Excel 内容，请上传任课表或 AI 约束清单。', 'unknown_xlsx_shape', 400);
}

function rowsToObjects(rows = []) {
    const header = (rows[0] || []).map(normalizeHeader);
    return rows.slice(1)
        .map((row, index) => {
            const item = { sourceRow: index + 2 };
            header.forEach((key, columnIndex) => {
                if (key) item[key] = row[columnIndex];
            });
            return item;
        })
        .filter(item => Object.values(item).some(value => asText(value, 200)));
}

function constraintsTextFromRows(rows = []) {
    const objects = rowsToObjects(rows);
    const items = objects.map(item => {
        const direct = asText(item.constraintText, 1000);
        if (direct) return direct;
        return [
            item.ruleName ? `名称：${item.ruleName}` : '',
            item.ruleType ? `类型：${item.ruleType}` : '',
            item.target ? `对象：${item.target}` : '',
            item.days ? `周几：${item.days}` : '',
            item.periods ? `节次：${item.periods}` : '',
            item.slots ? `时间：${item.slots}` : '',
            item.priority ? `强度：${item.priority}` : '',
            item.description ? `说明：${item.description}` : '',
        ].filter(Boolean).join('；');
    }).filter(Boolean);
    if (!items.length) {
        throw new TimetableRuleParseError('约束清单里没有可解析的规则文本。', 'empty_prompt', 400);
    }
    return {
        text: items.map((item, index) => `${index + 1}. ${item}`).join('\n'),
        rows: objects,
    };
}

function normalizeSlotList(values = []) {
    const raw = Array.isArray(values) ? values : String(values || '').split(/[,，;；、\s]+/);
    const result = [];
    for (const value of raw) {
        if (typeof value === 'string' && /^\d{1,2}-\d{1,2}$/.test(value.trim())) {
            const [day, period] = value.trim().split('-').map(item => Number.parseInt(item, 10));
            result.push(slotKey(day, period));
        } else if (value && Number.isInteger(Number(value.day)) && Number.isInteger(Number(value.period))) {
            result.push(slotKey(value.day, value.period));
        }
    }
    return [...new Set(result)].sort();
}

function numberList(values = [], fallback = []) {
    const source = Array.isArray(values) ? values : String(values || '').split(/[,，;；、\s]+/);
    const result = source
        .map(value => Number.parseInt(String(value).replace(/[^\d]/g, ''), 10))
        .filter(value => Number.isInteger(value));
    return [...new Set(result.length ? result : fallback)].sort((left, right) => left - right);
}

function slotsFromConstraint(constraint = {}, project = {}) {
    const direct = normalizeSlotList(constraint.slots || constraint.slotKeys || constraint.times || constraint.timeSlots);
    if (direct.length) return direct;
    const days = numberList(constraint.days || constraint.weekdays, getActiveWeekdays(project));
    const periods = numberList(constraint.periods || constraint.lessonIndexes || constraint.periodIndexes, []);
    if (!periods.length) return [];
    const slots = [];
    for (const day of days) {
        for (const period of periods) slots.push(slotKey(day, period));
    }
    return [...new Set(slots)].sort();
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

function addSubjectPeriodPreference(rules, subjectId, { prefer = [], avoid = [], weight = 20 } = {}) {
    if (!subjectId) return;
    rules.softRules.subjectPreferredPeriods = { ...(rules.softRules.subjectPreferredPeriods || {}) };
    const current = rules.softRules.subjectPreferredPeriods[subjectId] || { prefer: [], avoid: [], weight };
    rules.softRules.subjectPreferredPeriods[subjectId] = {
        prefer: [...new Set([...(current.prefer || []), ...prefer])].sort(),
        avoid: [...new Set([...(current.avoid || []), ...avoid])].sort(),
        weight: Math.max(1, Math.min(100, Number.parseInt(weight ?? current.weight ?? 20, 10) || 20)),
    };
}

function previewItem({
    index,
    type,
    target,
    targetName = '',
    targetId = '',
    slots = [],
    priority = 'hard',
    description = '',
    status = 'ready',
}) {
    return {
        id: `draft_${index + 1}`,
        type,
        targetId: target?.id || targetId || '',
        targetName: target ? (target.grade ? `${target.grade}${target.name}` : target.name || '') : targetName,
        slots,
        priority,
        description,
        status,
        effective: status === 'ready',
    };
}

function normalizeConstraintType(value) {
    return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

function applyConstraint({ constraint, project, rules, warnings, unsupportedItems, index }) {
    const type = normalizeConstraintType(constraint.type || constraint.ruleType);
    const priority = constraint.priority === 'soft' ? 'soft' : type.startsWith('subject_') ? 'soft' : 'hard';
    const description = cleanText(constraint.reason || constraint.description || constraint.note || '', 180);
    const slots = slotsFromConstraint(constraint, project);

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

    if (['subject_preferred_periods', 'subject_prefer_periods', 'subject_preferred_slots'].includes(type)) {
        const subject = findEntity(project.subjects, constraint, ['subject', 'target']);
        if (!subject || !slots.length) {
            warnings.push(`第 ${index + 1} 条课程偏好节次规则缺少课程或节次，已跳过。`);
            return null;
        }
        addSubjectPeriodPreference(rules, subject.id, { prefer: slots, weight: constraint.weight });
        return previewItem({ index, type: 'subject_preferred_periods', target: subject, slots, priority: 'soft', description });
    }

    if (['subject_avoid_periods', 'subject_avoid_slots'].includes(type)) {
        const subject = findEntity(project.subjects, constraint, ['subject', 'target']);
        if (!subject || !slots.length) {
            warnings.push(`第 ${index + 1} 条课程避开节次规则缺少课程或节次，已跳过。`);
            return null;
        }
        addSubjectPeriodPreference(rules, subject.id, { avoid: slots, weight: constraint.weight });
        return previewItem({ index, type: 'subject_avoid_periods', target: subject, slots, priority: 'soft', description });
    }

    if (SUGGESTION_ONLY_TYPES.has(type)) {
        const item = previewItem({
            index,
            type,
            targetName: cleanText(constraint.target || constraint.targetName || constraint.subject || constraint.teacher || '全局建议', 80),
            slots,
            priority,
            description,
            status: 'suggestion',
        });
        unsupportedItems.push(item);
        return item;
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

function buildPrompt({ project, text, inputType = 'text', contextStats = null, constraintRows = [] }) {
    return [
        {
            role: 'system',
            content: [
                'You convert Chinese school timetable requests into strict JSON.',
                'Return only JSON: {"constraints":[...],"warnings":[]}.',
                'Effective supported types: teacher_unavailable, class_unavailable, subject_morning, subject_preferred_periods, subject_avoid_periods.',
                'Suggestion-only types: teacher_load_balance, teacher_daily_limit, teacher_consecutive_limit, subject_spread, quality_subject_later, block_protection, class_daily_balance.',
                'Use targetId whenever possible. Slots must use "day-period", for example "3-4".',
                'Do not invent individual teacher unavailable time when the uploaded file does not include it.',
            ].join('\n'),
        },
        {
            role: 'user',
            content: JSON.stringify({
                inputType,
                request: text,
                contextStats,
                constraintRows,
                teachers: project.teachers.map(({ id, name }) => ({ id, name })),
                classes: project.classes.map(({ id, grade, name }) => ({ id, name: `${grade}${name}` })),
                subjects: project.subjects.map(({ id, name }) => ({ id, name })),
                activeWeekdays: project.activeWeekdays,
                activePeriods: project.activePeriods,
            }),
        },
    ];
}

async function callAi({ project, text, inputType, contextStats, constraintRows, env, fetchImpl }) {
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
            messages: buildPrompt({ project, text, inputType, contextStats, constraintRows }),
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
    try {
        return normalizeAiContent(content);
    } catch {
        throw new TimetableRuleParseError('AI 解析结果不是有效 JSON。', 'ai_invalid_json', 502);
    }
}

function applyConstraints({ constraints = [], project, inputType, contextStats = null, source = 'ai', initialWarnings = [] }) {
    const rules = cloneValue(project.rules);
    rules.hardRules = rules.hardRules || {};
    rules.hardRules.teacherUnavailable = { ...(rules.hardRules.teacherUnavailable || {}) };
    rules.hardRules.classUnavailable = { ...(rules.hardRules.classUnavailable || {}) };
    rules.hardRules.lockedSlots = [...(rules.hardRules.lockedSlots || [])];
    rules.softRules = rules.softRules || {};
    rules.softRules.morningSubjects = [...(rules.softRules.morningSubjects || [])];
    rules.softRules.subjectPreferredPeriods = { ...(rules.softRules.subjectPreferredPeriods || {}) };

    const warnings = [...initialWarnings];
    const unsupportedItems = [];
    const previewItems = constraints
        .map((constraint, index) => applyConstraint({ constraint, project, rules, warnings, unsupportedItems, index }))
        .filter(Boolean);

    return {
        draftRules: normalizeTimetableProject({ ...project, rules }).rules,
        previewItems,
        warnings: [...new Set(warnings)],
        source,
        inputType,
        contextStats,
        unsupportedItems,
    };
}

function rosterContext(preview = {}) {
    const rows = preview.draftRows || [];
    const subjects = new Map();
    const teachers = new Map();
    const classes = new Set();
    for (const row of rows) {
        if (row.className) classes.add(`${row.grade}${row.className}`);
        if (row.subjectName) {
            const subject = subjects.get(row.subjectName) || { name: row.subjectName, rows: 0, hours: 0, blocks: new Set() };
            subject.rows += 1;
            subject.hours += Number(row.weeklyHours || 0);
            subject.blocks.add(row.blockPreference || 'single');
            subjects.set(row.subjectName, subject);
        }
        for (const teacherName of String(row.teacherName || '').split(/[、,，/／;；\s]+/).filter(Boolean)) {
            teachers.set(teacherName, (teachers.get(teacherName) || 0) + Number(row.weeklyHours || 0));
        }
    }
    const highLoadTeachers = [...teachers.entries()]
        .filter(([, hours]) => hours >= 14)
        .sort((left, right) => right[1] - left[1])
        .map(([name, hours]) => ({ name, hours }));
    const mixedSubjects = [...subjects.values()]
        .filter(subject => subject.blocks.has('mixed') || subject.blocks.has('double'))
        .map(subject => subject.name);
    return {
        ...(preview.stats || {}),
        classes: classes.size,
        subjects: [...subjects.values()].map(subject => ({
            name: subject.name,
            rows: subject.rows,
            hours: subject.hours,
            blocks: [...subject.blocks],
        })),
        highLoadTeachers,
        mixedSubjects,
        totalLessons: preview.stats?.totalLessons || rows.reduce((sum, row) => sum + Number(row.weeklyHours || 0), 0),
    };
}

function findSubjectByName(project, names = []) {
    return project.subjects.find(subject => names.some(name => (
        subject.id === name
        || subject.name === name
        || subject.name.toLowerCase() === String(name).toLowerCase()
    )));
}

function laterSlots(project) {
    const periods = getActivePeriods(project);
    const later = periods.slice(Math.ceil(periods.length / 2));
    const slots = [];
    for (const day of getActiveWeekdays(project)) {
        for (const period of later) slots.push(slotKey(day, period));
    }
    return slots;
}

function buildLocalRosterConstraints(project, context) {
    const constraints = [];
    const subjectNames = new Set((context.subjects || []).map(subject => subject.name));
    const mainAliases = [
        ['语文', 'Chinese', 'Chinese Language'],
        ['数学', 'Math', 'Mathematics'],
        ['英语', 'English'],
    ];
    for (const aliases of mainAliases) {
        const subject = findSubjectByName(project, aliases.filter(name => subjectNames.has(name) || project.subjects.some(item => item.name === name)));
        if (subject) {
            constraints.push({
                type: 'subject_morning',
                targetId: subject.id,
                reason: '主科课时较多，建议上午优先。',
            });
        }
    }
    const lightAliases = [
        ['体育', 'PE', 'Sports'],
        ['音乐', 'Music'],
        ['美术', 'Art'],
        ['信息', 'ICT', 'Information'],
        ['劳动', 'Labor'],
    ];
    const afternoonSlots = laterSlots(project);
    for (const aliases of lightAliases) {
        const subject = findSubjectByName(project, aliases.filter(name => subjectNames.has(name) || project.subjects.some(item => item.name === name)));
        if (subject && afternoonSlots.length) {
            constraints.push({
                type: 'subject_preferred_periods',
                targetId: subject.id,
                slots: afternoonSlots,
                priority: 'soft',
                weight: 12,
                reason: '素质课建议排在后半天，用于平衡主科负载。',
            });
        }
    }
    for (const subjectName of context.mixedSubjects || []) {
        constraints.push({
            type: 'block_protection',
            target: subjectName,
            priority: 'soft',
            reason: '连堂或混合课程建议保留连续块，手动调整时整段处理。',
        });
    }
    if ((context.highLoadTeachers || []).length) {
        constraints.push({
            type: 'teacher_load_balance',
            target: context.highLoadTeachers.map(item => item.name).join('、'),
            priority: 'soft',
            reason: '高负载教师建议减少连续授课和碎片空堂。',
        });
    }
    return constraints;
}

async function parseRosterWorkbookRules({ file, project, env, fetchImpl }) {
    const preview = previewTimetableRosterFile(file, { project });
    const contextStats = rosterContext(preview);
    const prompt = [
        '请根据这份任课表生成排课约束草稿。',
        '只能根据数据推导通用规则，不要虚构具体教师不可排时间。',
        JSON.stringify(contextStats),
    ].join('\n');

    try {
        const parsed = await callAi({
            project,
            text: prompt,
            inputType: 'xlsx_roster',
            contextStats,
            constraintRows: preview.draftRows,
            env,
            fetchImpl,
        });
        const constraints = Array.isArray(parsed.constraints) ? parsed.constraints : Array.isArray(parsed.rules) ? parsed.rules : [];
        const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(item => cleanText(item, 160)).filter(Boolean) : [];
        return applyConstraints({ constraints, project, inputType: 'xlsx_roster', contextStats, source: 'ai', initialWarnings: warnings });
    } catch (error) {
        const constraints = buildLocalRosterConstraints(project, contextStats);
        return applyConstraints({
            constraints,
            project,
            inputType: 'xlsx_roster',
            contextStats,
            source: 'local_roster_fallback',
            initialWarnings: [`AI 不可用，已根据任课表生成本地基础建议：${error.reason || error.message}`],
        });
    }
}

async function parseConstraintWorkbookRules({ sheet, project, env, fetchImpl }) {
    const extracted = constraintsTextFromRows(sheet.rows);
    const parsed = await callAi({
        project,
        text: extracted.text,
        inputType: 'xlsx_constraints',
        contextStats: { rowCount: extracted.rows.length, sheetName: sheet.name },
        constraintRows: extracted.rows,
        env,
        fetchImpl,
    });
    const constraints = Array.isArray(parsed.constraints) ? parsed.constraints : Array.isArray(parsed.rules) ? parsed.rules : [];
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(item => cleanText(item, 160)).filter(Boolean) : [];
    return applyConstraints({
        constraints,
        project,
        inputType: 'xlsx_constraints',
        contextStats: { rowCount: extracted.rows.length, sheetName: sheet.name },
        source: 'ai',
        initialWarnings: warnings,
    });
}

export async function parseTimetableRules({
    text = '',
    file = null,
    project: inputProject = {},
    env = process.env,
    fetchImpl,
} = {}) {
    const project = normalizeTimetableProject(inputProject);

    if (file?.buffer) {
        const sheets = workbookSheets(file);
        const classified = classifyWorkbook(sheets);
        if (classified.inputType === 'xlsx_roster') {
            return parseRosterWorkbookRules({ file, project, env, fetchImpl });
        }
        return parseConstraintWorkbookRules({ sheet: classified.sheet, project, env, fetchImpl });
    }

    const prompt = cleanText(text, 2000);
    if (!prompt) {
        throw new TimetableRuleParseError('请先输入要解析的排课约束。', 'empty_prompt', 400);
    }

    const parsed = await callAi({
        project,
        text: prompt,
        inputType: 'text',
        contextStats: null,
        constraintRows: [],
        env,
        fetchImpl,
    });
    const constraints = Array.isArray(parsed.constraints) ? parsed.constraints : Array.isArray(parsed.rules) ? parsed.rules : [];
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(item => cleanText(item, 160)).filter(Boolean) : [];
    return applyConstraints({ constraints, project, inputType: 'text', contextStats: null, source: 'ai', initialWarnings: warnings });
}
