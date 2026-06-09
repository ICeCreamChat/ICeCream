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
    buildTimetableRosterFromRows,
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

const STATUS_LABELS = new Set(['effective', 'ready', 'needs_review', 'suggestion', 'unsupported', 'invalid', 'ignored']);
const DAY_NAME_TO_NUMBER = new Map([
    ['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['日', 7], ['天', 7],
    ['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7],
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
        values.push(asText(text, 1000));
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
            row[columnIndex(ref)] = asText(text, 1000);
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
        const xml = readEntry(zip, entryName);
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
    const text = asText(value, 120).toLowerCase();
    if (/^(id|编号|序号)$/.test(text)) return 'id';
    if (/年级|grade/.test(text)) return 'grade';
    if (/班级|class/.test(text)) return 'className';
    if (/课程|科目|学科|subject|course/.test(text)) return 'subjectName';
    if (/教师|老师|teacher/.test(text)) return 'teacherName';
    if (/周课时|课时|hours|hour/.test(text)) return 'weeklyHours';
    if (/连堂|block/.test(text)) return 'blockPreference';
    if (/自然语言|可复制给ai|约束描述|约束内容|constraint|request|prompt|natural/.test(text)) return 'constraintText';
    if (/约束名称|规则名称|rule name|name/.test(text)) return 'ruleName';
    if (/约束类型|规则类型|类型|type/.test(text)) return 'ruleType';
    if (/对象范围|对象|目标|target|scope/.test(text)) return 'target';
    if (/适用周几|周几|星期|weekday|day/.test(text)) return 'days';
    if (/适用节次|节次|period|time/.test(text)) return 'periods';
    if (/slot|时间格|时间/.test(text)) return 'slots';
    if (/强度|优先级|priority|hard|soft/.test(text)) return 'priority';
    if (/建议权重|权重|weight/.test(text)) return 'weight';
    if (/建议状态|状态|status/.test(text)) return 'enabled';
    if (/生成依据|依据|原因|说明|备注|reason|note|description/.test(text)) return 'description';
    return null;
}

function headerInfo(rows = []) {
    let best = { rowIndex: -1, header: [], score: 0 };
    rows.slice(0, 12).forEach((row, rowIndex) => {
        const header = row.map(normalizeHeader);
        const score = header.filter(Boolean).length;
        if (score > best.score) best = { rowIndex, header, score };
    });
    return best;
}

function scoreConstraintSheet(sheet = {}) {
    const info = headerInfo(sheet.rows || []);
    const keys = new Set(info.header.filter(Boolean));
    const headerScore = [
        'constraintText',
        'ruleName',
        'ruleType',
        'target',
        'days',
        'periods',
        'priority',
    ].filter(key => keys.has(key)).length;
    const nameScore = /ai|约束|规则|建议|constraint|rules?|prompt/i.test(sheet.name || '') ? 3 : 0;
    const text = (sheet.rows || []).slice(0, 30).flat().map(value => asText(value, 80)).join(' ');
    const contentScore = /(约束|规则|不可排|不要排|上午优先|优先|避免|冲突|连堂|自然语言)/.test(text) ? 2 : 0;
    return { ...info, score: headerScore + nameScore + contentScore };
}

function scoreRosterSheet(sheet = {}) {
    const info = headerInfo(sheet.rows || []);
    const keys = new Set(info.header.filter(Boolean));
    const rosterScore = ['className', 'subjectName', 'teacherName', 'weeklyHours']
        .filter(key => keys.has(key)).length;
    return { ...info, score: rosterScore };
}

function classifyWorkbook(sheets = []) {
    const constraints = sheets
        .map(sheet => ({ sheet, ...scoreConstraintSheet(sheet) }))
        .sort((left, right) => right.score - left.score)[0];
    const roster = sheets
        .map(sheet => ({ sheet, ...scoreRosterSheet(sheet) }))
        .sort((left, right) => right.score - left.score)[0];

    if (constraints && constraints.score >= 4) {
        return { inputType: 'xlsx_constraints', sheet: constraints.sheet, header: constraints.header, headerRowIndex: constraints.rowIndex };
    }
    if (roster && roster.score >= 3) {
        return { inputType: 'xlsx_roster', sheet: roster.sheet, header: roster.header, headerRowIndex: roster.rowIndex };
    }
    if (constraints && constraints.score >= 2) {
        return { inputType: 'xlsx_constraints', sheet: constraints.sheet, header: constraints.header, headerRowIndex: constraints.rowIndex };
    }
    throw new TimetableRuleParseError('无法识别 Excel 内容，请上传任课表、AI 约束清单或文本约束文件。', 'unknown_xlsx_shape', 400);
}

function rowsToObjects(rows = [], header = null, headerRowIndex = null, sheetName = '') {
    const info = header ? { header, rowIndex: headerRowIndex ?? 0 } : headerInfo(rows);
    const start = info.rowIndex >= 0 ? info.rowIndex + 1 : 0;
    if (info.score <= 0) {
        return rows.map((row, index) => ({
            sourceRow: index + 1,
            sourceSheet: sheetName,
            constraintText: row.map(value => asText(value, 300)).filter(Boolean).join('；'),
        })).filter(item => item.constraintText);
    }
    return rows.slice(start)
        .map((row, index) => {
            const item = { sourceRow: start + index + 1, sourceSheet: sheetName };
            info.header.forEach((key, columnIndex) => {
                if (key) item[key] = row[columnIndex];
            });
            if (!item.constraintText) {
                item.constraintText = row.map(value => asText(value, 240)).filter(Boolean).join('；');
            }
            return item;
        })
        .filter(item => Object.values(item).some(value => asText(value, 200)));
}

function constraintsTextFromSheet({ sheet, header, headerRowIndex }) {
    const rows = rowsToObjects(sheet.rows || [], header, headerRowIndex, sheet.name || '');
    const items = rows.map(item => {
        const direct = asText(item.constraintText, 1500);
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
        rows,
    };
}

function normalizeConstraintType(value) {
    const text = String(value || '').trim().toLowerCase().replace(/-/g, '_');
    const compact = text.replace(/\s+/g, '');
    if (['teacherunavailable', '教师不可排', '教师不排', '教师时间不可用', 'teacher_not_available'].includes(compact)) return 'teacher_unavailable';
    if (['classunavailable', '班级不可排', '班级不排', 'class_not_available'].includes(compact)) return 'class_unavailable';
    if (['subjectmorning', '课程上午优先', '主科上午', '上午优先', 'morning_subject', 'subject_prefer_morning'].includes(compact)) return 'subject_morning';
    if (['subjectpreferperiods', 'subjectpreferredperiods', '课程偏好节次', '课程优先节次', 'subject_prefer_periods', 'subject_preferred_slots'].includes(compact)) return 'subject_preferred_periods';
    if (['subjectavoidperiods', '课程避开节次', 'subject_avoid_slots'].includes(compact)) return 'subject_avoid_periods';
    if (/教师.*(均衡|负载)|teacher.*load/.test(text)) return 'teacher_load_balance';
    if (/连堂.*(保护|不可拆)|block/.test(text)) return 'block_protection';
    if (/同科.*分散|subject.*spread/.test(text)) return 'subject_spread';
    return text;
}

function normalizePriority(value, type) {
    const text = String(value || '').toLowerCase();
    if (/软|soft|建议/.test(text)) return 'soft';
    if (/硬|hard|必须|不可|不能/.test(text)) return 'hard';
    return String(type || '').startsWith('subject_') || SUGGESTION_ONLY_TYPES.has(type) ? 'soft' : 'hard';
}

function dayNumber(value) {
    return DAY_NAME_TO_NUMBER.get(String(value || '').trim()) || null;
}

function uniqueNumbers(values = []) {
    return [...new Set(values.map(value => Number.parseInt(value, 10)).filter(value => Number.isInteger(value)))]
        .sort((left, right) => left - right);
}

function expandRange(left, right, max = 12) {
    const start = Math.max(1, Number.parseInt(left, 10));
    const end = Math.min(max, Number.parseInt(right, 10));
    if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
    const [from, to] = start <= end ? [start, end] : [end, start];
    return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function parseDays(value, project, fallback = []) {
    if (Array.isArray(value)) return uniqueNumbers(value);
    const text = asText(value, 300);
    if (!text) return [...fallback];
    if (/全部|全周|每天|all/i.test(text)) return getActiveWeekdays(project);
    if (/工作日|周一.?周五|周一到周五|monday.?friday/i.test(text)) return getActiveWeekdays(project).filter(day => day <= 5);
    const values = [];
    for (const match of text.matchAll(/(?:周|星期|礼拜)([一二三四五六日天1-7])/g)) {
        const number = dayNumber(match[1]);
        if (number) values.push(number);
    }
    if (!values.length && /^[1-7](?:[,，、\s]+[1-7])*$/.test(text)) {
        values.push(...text.split(/[,，、\s]+/).map(item => Number.parseInt(item, 10)));
    }
    return uniqueNumbers(values.length ? values : fallback);
}

function parsePeriods(value, project, fallback = []) {
    if (Array.isArray(value)) return uniqueNumbers(value);
    const text = asText(value, 300);
    if (!text) return [...fallback];
    const active = getActivePeriods(project);
    if (/全部|全日|all/i.test(text)) return active;
    if (/上午|早上/.test(text)) return active.filter(period => period <= Math.ceil(active.length / 2));
    if (/下午|后半天/.test(text)) return active.filter(period => period > Math.ceil(active.length / 2));
    const values = [];
    for (const range of text.matchAll(/第?\s*(\d{1,2})\s*[-~到至]\s*(\d{1,2})\s*节?/g)) {
        values.push(...expandRange(range[1], range[2], Math.max(...active, 12)));
    }
    for (const match of text.matchAll(/第?\s*(\d{1,2})\s*节/g)) {
        values.push(Number.parseInt(match[1], 10));
    }
    if (!values.length && /^\d{1,2}$/.test(text)) values.push(Number.parseInt(text, 10));
    return uniqueNumbers(values.length ? values : fallback);
}

function normalizeSlotList(values = []) {
    const source = Array.isArray(values) ? values : String(values || '').split(/[,，;；、\s]+/);
    const result = [];
    for (const value of source) {
        if (typeof value === 'string' && /^\d{1,2}-\d{1,2}$/.test(value.trim())) {
            const [day, period] = value.trim().split('-').map(item => Number.parseInt(item, 10));
            result.push(slotKey(day, period));
        } else if (value && Number.isInteger(Number(value.day)) && Number.isInteger(Number(value.period))) {
            result.push(slotKey(value.day, value.period));
        }
    }
    return [...new Set(result)].sort();
}

function slotsFromConstraint(constraint = {}, project = {}) {
    const direct = normalizeSlotList(constraint.slots || constraint.slotKeys || constraint.times || constraint.timeSlots);
    if (direct.length) return direct;
    const days = parseDays(constraint.days || constraint.weekdays || constraint.dayText, project, []);
    const periods = parsePeriods(constraint.periods || constraint.lessonIndexes || constraint.periodIndexes || constraint.periodText, project, []);
    if (!periods.length) return [];
    const targetDays = days.length ? days : getActiveWeekdays(project);
    const slots = [];
    for (const day of targetDays) {
        for (const period of periods) slots.push(slotKey(day, period));
    }
    return [...new Set(slots)].sort();
}

function normalizeName(value) {
    return asText(value, 120).toLowerCase().replace(/\s+/g, '');
}

function entityLabel(item = {}) {
    return item.grade ? `${item.grade}${item.name || ''}` : item.name || item.id || '';
}

function findEntity(items = [], { targetId = '', targetName = '', target = '', aliases = [] } = {}) {
    const candidates = [targetId, targetName, target, ...aliases].map(value => asText(value, 120)).filter(Boolean);
    for (const candidate of candidates) {
        const exact = items.find(item => item.id === candidate || item.name === candidate || entityLabel(item) === candidate);
        if (exact) return exact;
    }
    const normalized = candidates.map(normalizeName).filter(Boolean);
    for (const candidate of normalized) {
        const fuzzy = items.find(item => {
            const names = [item.id, item.name, entityLabel(item)].map(normalizeName);
            return names.some(name => name === candidate || name.includes(candidate) || candidate.includes(name));
        });
        if (fuzzy) return fuzzy;
    }
    return null;
}

function targetTypeFor(type, row = {}) {
    if (row.targetType) return row.targetType;
    if (type === 'teacher_unavailable') return 'teacher';
    if (type === 'class_unavailable') return 'class';
    if (type.startsWith('subject_')) return 'subject';
    return 'global';
}

function findTarget(project, row, type) {
    const targetType = targetTypeFor(type, row);
    if (targetType === 'teacher') return findEntity(project.teachers, row);
    if (targetType === 'class') return findEntity(project.classes, row);
    if (targetType === 'subject') return findEntity(project.subjects, row);
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

function normalizeDraftRow(row = {}, index = 0, project = {}) {
    const type = normalizeConstraintType(row.type || row.ruleType);
    const slots = slotsFromConstraint(row, project);
    const status = STATUS_LABELS.has(row.status) ? row.status : SUPPORTED_EFFECTIVE_TYPES.has(type) ? 'effective' : 'suggestion';
    return {
        id: asText(row.id, 120) || `rule_draft_${index + 1}`,
        source: asText(row.source || row.sourceSheet || '', 120),
        sourceRow: Number.parseInt(row.sourceRow, 10) || null,
        rawText: asText(row.rawText || row.constraintText || row.text || row.description || row.reason || '', 2000),
        type,
        targetType: targetTypeFor(type, row),
        targetId: asText(row.targetId || row.teacherId || row.classId || row.subjectId || '', 120),
        targetName: asText(row.targetName || row.target || row.teacher || row.teacherName || row.class || row.className || row.subject || row.subjectName || '', 200),
        slots,
        days: parseDays(row.days || row.weekdays || '', project, []),
        periods: parsePeriods(row.periods || row.lessonIndexes || '', project, []),
        priority: normalizePriority(row.priority || row.strength, type),
        status: status === 'ready' ? 'effective' : status,
        confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
        description: asText(row.description || row.reason || row.note || '', 500),
        warnings: Array.isArray(row.warnings) ? row.warnings.map(item => asText(item, 200)).filter(Boolean) : [],
        weight: Number.parseInt(row.weight, 10) || undefined,
    };
}

function previewFromRow(row = {}) {
    return {
        id: row.id,
        type: row.type,
        targetId: row.targetId || '',
        targetName: row.targetName || '',
        slots: row.slots || [],
        priority: row.priority || 'hard',
        description: row.description || row.rawText || '',
        status: row.status === 'effective' ? 'ready' : row.status,
        effective: row.status === 'effective',
        confidence: row.confidence,
    };
}

function emptyRulesFrom(project) {
    const rules = cloneValue(project.rules);
    rules.hardRules = rules.hardRules || {};
    rules.hardRules.teacherUnavailable = { ...(rules.hardRules.teacherUnavailable || {}) };
    rules.hardRules.classUnavailable = { ...(rules.hardRules.classUnavailable || {}) };
    rules.hardRules.lockedSlots = [...(rules.hardRules.lockedSlots || [])];
    rules.softRules = rules.softRules || {};
    rules.softRules.morningSubjects = [...(rules.softRules.morningSubjects || [])];
    rules.softRules.subjectPreferredPeriods = { ...(rules.softRules.subjectPreferredPeriods || {}) };
    return rules;
}

export function normalizeTimetableRuleDraftRows({
    project: inputProject = {},
    draftRows = [],
    source = 'review',
    inputType = 'review',
    contextStats = null,
    initialWarnings = [],
} = {}) {
    const project = normalizeTimetableProject(inputProject);
    const rules = emptyRulesFrom(project);
    const warnings = [...initialWarnings].map(item => asText(item, 240)).filter(Boolean);
    const unsupportedItems = [];

    const rows = (Array.isArray(draftRows) ? draftRows : [])
        .map((row, index) => normalizeDraftRow(row, index, project))
        .map(row => {
            if (['ignored', 'suggestion', 'unsupported', 'invalid', 'needs_review'].includes(row.status)) {
                if (row.status === 'needs_review' && (row.targetName || row.targetId)) {
                    warnings.push(`${row.targetName || row.targetId} 需要复核后才能生效。`);
                }
                if (row.status === 'suggestion' || row.status === 'unsupported') unsupportedItems.push(previewFromRow(row));
                return row;
            }

            if (!SUPPORTED_EFFECTIVE_TYPES.has(row.type)) {
                const next = {
                    ...row,
                    status: SUGGESTION_ONLY_TYPES.has(row.type) ? 'suggestion' : 'unsupported',
                    warnings: [...row.warnings, '当前版本只能预览这类建议，暂不会写入排课规则。'],
                };
                unsupportedItems.push(previewFromRow(next));
                return next;
            }

            const target = findTarget(project, row, row.type);
            const targetType = targetTypeFor(row.type, row);
            const slots = row.slots || [];

            if (row.type === 'teacher_unavailable') {
                if (!target || !slots.length) {
                    const reason = `${row.targetName || row.targetId || '教师'} 缺少可匹配教师或节次，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'teacher', warnings: [...row.warnings, reason] };
                }
                addSlots(rules.hardRules.teacherUnavailable, target.id, slots);
                return { ...row, targetType, targetId: target.id, targetName: target.name || row.targetName, status: 'effective' };
            }

            if (row.type === 'class_unavailable') {
                if (!target || !slots.length) {
                    const reason = `${row.targetName || row.targetId || '班级'} 缺少可匹配班级或节次，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'class', warnings: [...row.warnings, reason] };
                }
                addSlots(rules.hardRules.classUnavailable, target.id, slots);
                return { ...row, targetType, targetId: target.id, targetName: entityLabel(target), status: 'effective' };
            }

            if (row.type === 'subject_morning') {
                if (!target) {
                    const reason = `${row.targetName || row.targetId || '课程'} 缺少可匹配课程，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'subject', warnings: [...row.warnings, reason] };
                }
                addMorningSubject(rules, target.id);
                return { ...row, targetType, targetId: target.id, targetName: target.name || row.targetName, status: 'effective' };
            }

            if (row.type === 'subject_preferred_periods' || row.type === 'subject_avoid_periods') {
                if (!target || !slots.length) {
                    const reason = `${row.targetName || row.targetId || '课程'} 缺少可匹配课程或节次，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'subject', warnings: [...row.warnings, reason] };
                }
                addSubjectPeriodPreference(rules, target.id, {
                    prefer: row.type === 'subject_preferred_periods' ? slots : [],
                    avoid: row.type === 'subject_avoid_periods' ? slots : [],
                    weight: row.weight,
                });
                return { ...row, targetType, targetId: target.id, targetName: target.name || row.targetName, status: 'effective' };
            }

            return { ...row, status: 'unsupported' };
        });

    return {
        draftRules: normalizeTimetableProject({ ...project, rules }).rules,
        draftRows: rows,
        previewItems: rows.map(previewFromRow),
        warnings: [...new Set(warnings.filter(Boolean))],
        source,
        inputType,
        contextStats,
        unsupportedItems,
    };
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
                'You convert flexible Chinese school timetable constraints into strict JSON.',
                'Return only JSON: {"constraints":[...],"warnings":[]}.',
                'Supported effective types: teacher_unavailable, class_unavailable, subject_morning, subject_preferred_periods, subject_avoid_periods.',
                'Suggestion-only types: teacher_load_balance, teacher_daily_limit, teacher_consecutive_limit, subject_spread, quality_subject_later, block_protection, class_daily_balance.',
                'Each constraint should include type, targetId or target, days/periods or slots, priority, reason, confidence.',
                'Slots must use "day-period", for example "3-4".',
                'If a document describes general built-in facts such as teacher/class conflict, mark it as suggestion-only instead of inventing unsupported hard rules.',
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

function rowsFromAiConstraints(constraints = [], { inputRows = [], source = 'ai' } = {}) {
    return constraints.map((constraint, index) => {
        const inputRow = inputRows[index] || {};
        const type = normalizeConstraintType(constraint.type || constraint.ruleType);
        return {
            id: asText(constraint.id || inputRow.id, 80) || `rule_draft_${index + 1}`,
            source,
            sourceSheet: inputRow.sourceSheet,
            sourceRow: inputRow.sourceRow,
            rawText: constraint.rawText || inputRow.constraintText || constraint.reason || constraint.description || '',
            type,
            targetType: constraint.targetType || targetTypeFor(type, constraint),
            targetId: constraint.targetId || constraint.teacherId || constraint.classId || constraint.subjectId || '',
            targetName: constraint.targetName || constraint.target || constraint.teacher || constraint.class || constraint.subject || '',
            slots: constraint.slots || constraint.slotKeys || [],
            days: constraint.days || constraint.weekdays || '',
            periods: constraint.periods || constraint.lessonIndexes || '',
            priority: constraint.priority || constraint.strength,
            status: SUPPORTED_EFFECTIVE_TYPES.has(type) ? 'effective' : SUGGESTION_ONLY_TYPES.has(type) ? 'suggestion' : 'unsupported',
            confidence: constraint.confidence ?? null,
            description: constraint.reason || constraint.description || constraint.note || '',
            warnings: [],
            weight: constraint.weight,
        };
    });
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
        for (const teacherName of String(row.teacherName || '').split(/[、，,；;\s]+/).filter(Boolean)) {
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

function mergeEntitiesByName(existing = [], inferred = [], labelFor = item => item.name || item.id || '') {
    const result = [...(Array.isArray(existing) ? existing : [])];
    const seen = new Set(result.map(item => normalizeName(labelFor(item))).filter(Boolean));
    for (const item of Array.isArray(inferred) ? inferred : []) {
        const key = normalizeName(labelFor(item));
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(item);
    }
    return result;
}

function projectWithRosterPreview(project, preview) {
    try {
        const roster = buildTimetableRosterFromRows(preview.draftRows || [], { project });
        return normalizeTimetableProject({
            ...project,
            teachers: mergeEntitiesByName(project.teachers, roster.teachers, item => item.name || item.id),
            classes: mergeEntitiesByName(project.classes, roster.classes, entityLabel),
            subjects: mergeEntitiesByName(project.subjects, roster.subjects, item => item.name || item.id),
            lessonPlans: (project.lessonPlans || []).length ? project.lessonPlans : roster.lessonPlans,
        });
    } catch {
        return project;
    }
}

function localRosterConstraints(project, context) {
    const constraints = [];
    const subjectNames = new Set((context.subjects || []).map(subject => normalizeName(subject.name)));
    const mainSubjects = project.subjects.filter(subject => {
        const name = normalizeName(subject.name);
        return subjectNames.has(name) && /(语文|数学|英语|chinese|math|english)/i.test(subject.name);
    });
    mainSubjects.forEach(subject => {
        constraints.push({
            type: 'subject_morning',
            targetId: subject.id,
            reason: '主科课时较多，建议上午优先。',
        });
    });

    const later = [];
    const active = getActivePeriods(project);
    const laterPeriods = active.filter(period => period > Math.ceil(active.length / 2));
    for (const day of getActiveWeekdays(project)) {
        laterPeriods.forEach(period => later.push(slotKey(day, period)));
    }
    project.subjects
        .filter(subject => /(体育|音乐|美术|信息|劳动|pe|music|art|ict|labor)/i.test(subject.name) && subjectNames.has(normalizeName(subject.name)))
        .forEach(subject => constraints.push({
            type: 'subject_preferred_periods',
            targetId: subject.id,
            slots: later,
            priority: 'soft',
            reason: '素质课建议分布到后半天，平衡主科负载。',
        }));

    (context.mixedSubjects || []).forEach(subjectName => constraints.push({
        type: 'block_protection',
        target: subjectName,
        priority: 'soft',
        reason: '连堂或混合课程建议保留连续块，手动调整时整段处理。',
    }));

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

function normalizeRosterFallback({ project, preview, contextStats, initialWarnings = [] }) {
    const constraints = localRosterConstraints(project, contextStats);
    return normalizeTimetableRuleDraftRows({
        project,
        draftRows: rowsFromAiConstraints(constraints, { inputRows: preview.draftRows, source: 'local_roster_fallback' }),
        source: 'local_roster_fallback',
        inputType: 'xlsx_roster',
        contextStats,
        initialWarnings,
    });
}

function splitSentences(text = '') {
    return String(text)
        .split(/[\n。；;，,!?！？]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function textSlots(sentence, project) {
    const days = parseDays(sentence, project, []);
    const periods = parsePeriods(sentence, project, []);
    if (!periods.length) return [];
    const targetDays = days.length ? days : getActiveWeekdays(project);
    return targetDays.flatMap(day => periods.map(period => slotKey(day, period)));
}

function localTextConstraints(project, text) {
    const constraints = [];
    const sentences = splitSentences(text);
    const unavailablePattern = /(不要排|不排|不可排|不能排|没空|不可用|unavailable|avoid)/i;
    const preferPattern = /(优先|尽量|prefer|preferred|安排到)/i;
    const avoidPattern = /(避开|不要|不排|avoid)/i;

    for (const sentence of sentences) {
        const slots = textSlots(sentence, project);
        project.teachers.forEach(teacher => {
            if (sentence.includes(teacher.name) && unavailablePattern.test(sentence) && slots.length) {
                constraints.push({
                    type: 'teacher_unavailable',
                    targetId: teacher.id,
                    target: teacher.name,
                    slots,
                    priority: 'hard',
                    reason: sentence,
                    confidence: 0.86,
                });
            }
        });
        project.classes.forEach(klass => {
            const label = entityLabel(klass);
            if ((sentence.includes(label) || sentence.includes(klass.name)) && unavailablePattern.test(sentence) && slots.length) {
                constraints.push({
                    type: 'class_unavailable',
                    targetId: klass.id,
                    target: label,
                    slots,
                    priority: 'hard',
                    reason: sentence,
                    confidence: 0.84,
                });
            }
        });
        project.subjects.forEach(subject => {
            if (!sentence.includes(subject.name)) return;
            const teacherUnavailableSentence = project.teachers.some(teacher => sentence.includes(teacher.name))
                && unavailablePattern.test(sentence)
                && !preferPattern.test(sentence);
            if (teacherUnavailableSentence) return;
            if (/上午|早上/.test(sentence) && preferPattern.test(sentence)) {
                constraints.push({
                    type: 'subject_morning',
                    targetId: subject.id,
                    target: subject.name,
                    priority: 'soft',
                    reason: sentence,
                    confidence: 0.82,
                });
            } else if (slots.length && preferPattern.test(sentence)) {
                constraints.push({
                    type: 'subject_preferred_periods',
                    targetId: subject.id,
                    target: subject.name,
                    slots,
                    priority: 'soft',
                    reason: sentence,
                    confidence: 0.76,
                });
            } else if (slots.length && avoidPattern.test(sentence)) {
                constraints.push({
                    type: 'subject_avoid_periods',
                    targetId: subject.id,
                    target: subject.name,
                    slots,
                    priority: 'soft',
                    reason: sentence,
                    confidence: 0.76,
                });
            }
        });
        if (/语数英|语文.*数学.*英语|数学.*语文.*英语|main subjects/i.test(sentence) && /上午|早上/.test(sentence)) {
            project.subjects
                .filter(subject => /(语文|数学|英语|chinese|math|english)/i.test(subject.name))
                .forEach(subject => constraints.push({
                    type: 'subject_morning',
                    targetId: subject.id,
                    target: subject.name,
                    priority: 'soft',
                    reason: sentence,
                    confidence: 0.8,
                }));
        }
    }

    const seen = new Set();
    return constraints.filter(item => {
        const key = JSON.stringify([item.type, item.targetId, item.slots || []]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function parseConstraintsWithLocalFallback({ project, text, inputType, contextStats = null, constraintRows = [], error = null }) {
    const constraints = localTextConstraints(project, text);
    if (!constraints.length) {
        if (error) throw error;
        throw new TimetableRuleParseError('需要配置 AI 才能智能解析这类约束。', 'ai_not_configured', 503);
    }
    return normalizeTimetableRuleDraftRows({
        project,
        draftRows: rowsFromAiConstraints(constraints, { inputRows: constraintRows, source: 'local_text' }),
        source: 'local_text',
        inputType,
        contextStats,
        initialWarnings: error ? [`AI 不可用，已仅提取明确规则：${error.reason || error.message}`] : [],
    });
}

async function parseAiOrLocal({ project, text, inputType, contextStats = null, constraintRows = [], env, fetchImpl }) {
    try {
        const parsed = await callAi({ project, text, inputType, contextStats, constraintRows, env, fetchImpl });
        const constraints = Array.isArray(parsed.constraints) ? parsed.constraints : Array.isArray(parsed.rules) ? parsed.rules : [];
        const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(item => asText(item, 240)).filter(Boolean) : [];
        return normalizeTimetableRuleDraftRows({
            project,
            draftRows: rowsFromAiConstraints(constraints, { inputRows: constraintRows, source: 'ai' }),
            source: 'ai',
            inputType,
            contextStats,
            initialWarnings: warnings,
        });
    } catch (error) {
        if (error instanceof TimetableRuleParseError && ['ai_not_configured', 'missing_fetch'].includes(error.reason)) {
            return parseConstraintsWithLocalFallback({ project, text, inputType, contextStats, constraintRows, error });
        }
        throw error;
    }
}

async function parseRosterWorkbookRules({ file, project, env, fetchImpl }) {
    const preview = previewTimetableRosterFile(file, { project });
    const contextStats = rosterContext(preview);
    const rosterProject = projectWithRosterPreview(project, preview);
    const text = [
        '请根据这份任课表生成排课约束草稿。',
        '只能根据数据推导通用规则，不要虚构具体教师不可排时间。',
        JSON.stringify(contextStats),
    ].join('\n');

    try {
        const parsed = await parseAiOrLocal({
            project: rosterProject,
            text,
            inputType: 'xlsx_roster',
            contextStats,
            constraintRows: preview.draftRows,
            env,
            fetchImpl,
        });
        if ((parsed.draftRows || []).length) return parsed;
        return normalizeRosterFallback({
            project: rosterProject,
            preview,
            contextStats,
            initialWarnings: [
                ...(parsed.warnings || []),
                'AI 没有返回可复核的约束，已根据任课表生成本地基础建议。',
            ],
        });
    } catch (error) {
        return normalizeRosterFallback({
            project: rosterProject,
            preview,
            contextStats,
            initialWarnings: [`AI 不可用，已根据任课表生成本地基础建议：${error.reason || error.message}`],
        });
    }
}

async function parseConstraintWorkbookRules({ classified, project, env, fetchImpl }) {
    const extracted = constraintsTextFromSheet(classified);
    const contextStats = {
        rowCount: extracted.rows.length,
        sheetName: classified.sheet.name,
    };
    return parseAiOrLocal({
        project,
        text: extracted.text,
        inputType: 'xlsx_constraints',
        contextStats,
        constraintRows: extracted.rows,
        env,
        fetchImpl,
    });
}

function uploadText(file = {}) {
    if (!Buffer.isBuffer(file.buffer) || file.buffer.length <= 0) {
        throw new TimetableRuleParseError('上传的约束文件为空。', 'empty_file', 400);
    }
    if (file.buffer.length > MAX_RULE_FILE_BYTES) {
        throw new TimetableRuleParseError('约束文件不能超过 5MB。', 'file_too_large', 413);
    }
    return file.buffer.toString('utf8');
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
        const ext = path.extname(file.filename || '').toLowerCase();
        if (['.xlsx', '.xls'].includes(ext)) {
            const sheets = workbookSheets(file);
            const classified = classifyWorkbook(sheets);
            if (classified.inputType === 'xlsx_roster') {
                return parseRosterWorkbookRules({ file, project, env, fetchImpl });
            }
            return parseConstraintWorkbookRules({ classified, project, env, fetchImpl });
        }
        if (['.txt', '.csv'].includes(ext)) {
            const fileText = uploadText(file);
            return parseAiOrLocal({
                project,
                text: [text, fileText].filter(Boolean).join('\n'),
                inputType: ext === '.csv' ? 'csv_text' : 'txt',
                env,
                fetchImpl,
            });
        }
        throw new TimetableRuleParseError('AI 约束文件只支持 .txt、.csv、.xlsx、.xls。', 'unsupported_file_type', 400);
    }

    const prompt = cleanText(text, 4000);
    if (!prompt) {
        throw new TimetableRuleParseError('请先输入要解析的排课约束。', 'empty_prompt', 400);
    }

    return parseAiOrLocal({
        project,
        text: prompt,
        inputType: 'text',
        env,
        fetchImpl,
    });
}
