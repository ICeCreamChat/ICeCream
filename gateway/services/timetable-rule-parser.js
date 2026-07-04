import path from 'node:path';

import AdmZip from 'adm-zip';

import {
    cleanText,
    getActivePeriods,
    getDayPartPeriods,
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
    'locked_slot',
    'subject_morning',
    'subject_preferred_periods',
    'subject_avoid_periods',
    'teacher_daily_limit',
    'teacher_consecutive_limit',
    'subject_spread',
]);

const SUGGESTION_ONLY_TYPES = new Set([
    'teacher_load_balance',
    'quality_subject_later',
    'block_protection',
    'class_daily_balance',
    'class_subject_spread',
]);

const STATUS_LABELS = new Set(['effective', 'ready', 'needs_review', 'suggestion', 'unsupported', 'invalid', 'ignored']);
const DAY_NAME_TO_NUMBER = new Map([
    ['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['日', 7], ['天', 7],
    ['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7],
]);
const CHINESE_NUMBER_TO_VALUE = new Map([
    ['零', 0], ['〇', 0],
    ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5],
    ['六', 6], ['七', 7], ['八', 8], ['九', 9],
]);
const NUMBER_TOKEN_PATTERN = '[0-9一二两三四五六七八九十零〇]{1,4}';

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
        throw new TimetableRuleParseError('智能约束解析未配置，请先配置 API Key。', 'ai_not_configured', 503);
    }
    return { apiKey, baseUrl, model };
}

function resolveFetch(fetchImpl) {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    throw new TimetableRuleParseError('当前环境没有可用 fetch，无法调用智能解析。', 'missing_fetch', 503);
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
    throw new TimetableRuleParseError('无法识别 Excel 内容，请上传任课表、智能约束清单或文本约束文件。', 'unknown_xlsx_shape', 400);
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
    if (/教师.*每[天日].*(最多|上限|不超过)|teacher.*dail?y?.*(limit|max)/.test(text)) return 'teacher_daily_limit';
    if (/教师.*(连续|连堂|连排).*(最多|上限|不超过|限制)|teacher.*consecutive/.test(text)) return 'teacher_consecutive_limit';
    if (/(同科|同一?门?课|同学科).*(分散|不要?连?排?在?同一?天|错开)|subject.*spread/.test(text)) return 'subject_spread';
    if (/教师.*(均衡|负载)|teacher.*load/.test(text)) return 'teacher_load_balance';
    if (/连堂.*(保护|不可拆)|block/.test(text)) return 'block_protection';
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

function parseLooseNumber(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (/^\d{1,2}$/.test(text)) return Number.parseInt(text, 10);
    if (CHINESE_NUMBER_TO_VALUE.has(text)) return CHINESE_NUMBER_TO_VALUE.get(text);
    if (text === '十') return 10;
    const tenIndex = text.indexOf('十');
    if (tenIndex >= 0) {
        const left = text.slice(0, tenIndex);
        const right = text.slice(tenIndex + 1);
        const tens = left ? CHINESE_NUMBER_TO_VALUE.get(left) : 1;
        const ones = right ? CHINESE_NUMBER_TO_VALUE.get(right) : 0;
        if (Number.isInteger(tens) && Number.isInteger(ones)) return tens * 10 + ones;
    }
    return null;
}

function expandRange(left, right, max = 12) {
    const startValue = parseLooseNumber(left);
    const endValue = parseLooseNumber(right);
    const start = Math.max(1, Number.parseInt(startValue, 10));
    const end = Math.min(max, Number.parseInt(endValue, 10));
    if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
    const [from, to] = start <= end ? [start, end] : [end, start];
    return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function dayPartName(text = '') {
    if (/上午|早上|morning/i.test(text)) return 'morning';
    if (/下午|后半天|afternoon/i.test(text)) return 'afternoon';
    if (/晚间|晚上|晚自习|夜自习|evening|night/i.test(text)) return 'evening';
    return '';
}

function hasExplicitPeriodExpression(text = '') {
    const value = asText(text, 300);
    const rangePattern = new RegExp(`第?\\s*${NUMBER_TOKEN_PATTERN}\\s*[-~到至]\\s*${NUMBER_TOKEN_PATTERN}\\s*节?`);
    const singlePattern = new RegExp(`第\\s*${NUMBER_TOKEN_PATTERN}\\s*节|${NUMBER_TOKEN_PATTERN}\\s*节`);
    const relativePattern = new RegExp(`(?:前|后)\\s*${NUMBER_TOKEN_PATTERN}\\s*节`);
    return rangePattern.test(value) || singlePattern.test(value) || relativePattern.test(value);
}

function parseDays(value, project, fallback = []) {
    if (Array.isArray(value)) return uniqueNumbers(value);
    const text = asText(value, 300);
    if (!text) return [...fallback];
    if (/全部|全周|每天|all/i.test(text)) return getActiveWeekdays(project);
    if (/工作日|周一.?周五|周一到周五|monday.?friday/i.test(text)) return getActiveWeekdays(project).filter(day => day <= 5);
    const values = [];
    for (const range of text.matchAll(/(?:周|星期|礼拜)([一二三四五六日天1-7])\s*[-~到至]\s*(?:周|星期|礼拜)?([一二三四五六日天1-7])/g)) {
        const start = dayNumber(range[1]);
        const end = dayNumber(range[2]);
        if (start && end) values.push(...expandRange(start, end, 7));
    }
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
    const maxPeriod = Math.max(...active, 12);
    const values = [];
    if (/全部|全日|all/i.test(text)) return active;

    const rangePattern = new RegExp(`第?\\s*(${NUMBER_TOKEN_PATTERN})\\s*[-~到至]\\s*(${NUMBER_TOKEN_PATTERN})\\s*节?`, 'g');
    for (const range of text.matchAll(rangePattern)) {
        values.push(...expandRange(range[1], range[2], maxPeriod));
    }
    const singlePattern = new RegExp(`第?\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`, 'g');
    for (const match of text.matchAll(singlePattern)) {
        const period = parseLooseNumber(match[1]);
        if (Number.isInteger(period)) values.push(period);
    }
    const relativePattern = new RegExp(`(?:上午|早上|下午|后半天|晚间|晚上|晚自习|夜自习|morning|afternoon|evening|night)?\\s*(前|后)\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`, 'gi');
    for (const match of text.matchAll(relativePattern)) {
        const count = parseLooseNumber(match[2]);
        if (!Number.isInteger(count) || count <= 0) continue;
        const part = dayPartName(match[0]);
        const partPeriods = part ? getDayPartPeriods(project, part) : [];
        const base = partPeriods.length >= count ? partPeriods : active;
        const selected = match[1] === '前' ? base.slice(0, count) : base.slice(Math.max(0, base.length - count));
        values.push(...selected);
    }
    if (!values.length && /^\d{1,2}$/.test(text)) values.push(Number.parseInt(text, 10));
    if (!values.length && dayPartName(text)) return getDayPartPeriods(project, dayPartName(text));
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

function weekPatternFromText(value = '') {
    const text = asText(value, 300);
    if (/单双周/.test(text)) return 'odd_even';
    if (/单周|奇数周|odd\s*week/i.test(text)) return 'odd';
    if (/双周|偶数周|even\s*week/i.test(text)) return 'even';
    if (/隔周|每隔一周|alternat(?:e|ing)\s*week/i.test(text)) return 'alternating';
    return '';
}

function normalizeName(value) {
    return asText(value, 120).toLowerCase().replace(/\s+/g, '');
}

function normalizeEntityName(value) {
    return normalizeName(value)
        .replace(/[·\-_/()（）【】\[\]]/g, '')
        .replace(/年级/g, '')
        .replace(/班级/g, '班');
}

function entityLabel(item = {}) {
    if (item.grade && item.name && !item.name.startsWith(item.grade)) {
        return `${item.grade}${item.name}`;
    }
    return item.name || item.id || '';
}

function entityItemsForType(project = {}, targetType = '') {
    if (targetType === 'teacher') return project.teachers || [];
    if (targetType === 'class') return project.classes || [];
    if (targetType === 'subject') return project.subjects || [];
    return [];
}

function entityNamesForMatch(item = {}, targetType = '') {
    const names = [item.id, item.name, entityLabel(item)].map(value => asText(value, 120)).filter(Boolean);
    if (targetType === 'teacher' && item.name) {
        names.push(`${item.name}老师`, `${item.name}教师`);
    }
    return [...new Set(names)];
}

function candidatePreview(item = {}, targetType = '', confidence = 0) {
    return {
        id: item.id || '',
        name: item.name || entityLabel(item) || item.id || '',
        label: targetType === 'class' ? entityLabel(item) : (item.name || entityLabel(item) || item.id || ''),
        type: targetType,
        confidence,
        score: confidence,
    };
}

function isAllTeachersTarget(row = {}) {
    const text = [
        row.targetId,
        row.targetName,
        row.target,
        row.teacherId,
        row.teacherName,
        row.teacher,
        row.rawText,
        row.description,
    ].map(value => String(value || '')).join(' ');
    return /(全部|全体|所有|每位|每个|各位|任课|任意)\s*(教师|老师)|all\s+teachers?/i.test(text);
}

function shouldNormalizeAllTeachersTarget(row = {}, type = row.type || '') {
    if (!isAllTeachersTarget(row)) return false;
    return row.targetType === 'all_teachers'
        || type === 'teacher_daily_limit'
        || type === 'teacher_consecutive_limit'
        || String(type || '').startsWith('teacher_');
}

function normalizeAllTeachersTargetRow(row = {}) {
    return {
        ...row,
        targetType: 'all_teachers',
        targetId: '__all_teachers',
        targetName: '全部教师',
        ambiguity: null,
        ambiguities: [],
    };
}

function matchEntityCandidates(project = {}, targetText = '', targetType = '', { targetId = '' } = {}) {
    const items = entityItemsForType(project, targetType);
    const query = asText(targetText || targetId, 160);
    if (!items.length || (!query && !targetId)) return { candidates: [], confidence: 0, targetText: query };

    const scored = new Map();
    const add = (item, confidence, matchType = 'fuzzy') => {
        if (!item?.id) return;
        const current = scored.get(item.id);
        if (!current || confidence > current.confidence) {
            scored.set(item.id, {
                ...candidatePreview(item, targetType, confidence),
                matchType,
            });
        }
    };

    if (targetId) {
        const exactId = items.find(item => item.id === targetId);
        if (exactId) {
            // targetId 已明确指向一个实体时(如追问回填后),直接返回唯一候选
            const candidate = { ...candidatePreview(exactId, targetType, 1), matchType: 'exact' };
            return { candidates: [candidate], confidence: 1, targetText: query, targetType, matchType: 'exact' };
        }
    }

    const normalizedQuery = normalizeEntityName(query);
    for (const item of items) {
        const names = entityNamesForMatch(item, targetType);
        if (names.some(name => name === query)) add(item, 1, 'exact');
        if (normalizedQuery && names.map(normalizeEntityName).some(name => name === normalizedQuery)) add(item, 0.96, 'normalized');
    }

    if (normalizedQuery) {
        for (const item of items) {
            const names = entityNamesForMatch(item, targetType).map(normalizeEntityName).filter(Boolean);
            if (names.some(name => name.includes(normalizedQuery) || normalizedQuery.includes(name))) {
                add(item, normalizedQuery.length <= 2 ? 0.72 : 0.82, 'contains');
            }
        }
    }

    if (targetType === 'teacher' && /老师|教师/.test(query)) {
        const stem = normalizeEntityName(query.replace(/老师|教师/g, ''));
        if (stem) {
            for (const item of items) {
                const teacherName = normalizeEntityName(item.name || '');
                if (!teacherName) continue;
                if (stem.length === 1 ? teacherName.startsWith(stem) : teacherName.includes(stem)) {
                    add(item, stem.length === 1 ? 0.72 : 0.86, 'fuzzy');
                }
            }
        }
    }

    const candidates = [...scored.values()].sort((left, right) => {
        if (right.confidence !== left.confidence) return right.confidence - left.confidence;
        return left.label.localeCompare(right.label, 'zh-Hans-CN');
    });
    return {
        candidates,
        confidence: candidates.length > 1 ? Math.min(candidates[0]?.confidence || 0, 0.7) : candidates[0]?.confidence || 0,
        targetText: query,
        targetType,
        matchType: candidates.length ? candidates[0].matchType || 'fuzzy' : 'none',
    };
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
    if (type === 'teacher_daily_limit' || type === 'teacher_consecutive_limit') return 'teacher';
    if (type === 'class_unavailable') return 'class';
    if (type === 'locked_slot') return 'locked_slot';
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

function addTeacherLimit(rules, teacherId, { daily, consecutive } = {}) {
    if (!teacherId) return;
    rules.softRules.teacherLimits = { ...(rules.softRules.teacherLimits || {}) };
    const current = { ...(rules.softRules.teacherLimits[teacherId] || {}) };
    if (Number.isInteger(daily) && daily > 0) current.daily = Math.min(12, daily);
    if (Number.isInteger(consecutive) && consecutive > 0) current.consecutive = Math.min(12, consecutive);
    if (Object.keys(current).length) rules.softRules.teacherLimits[teacherId] = current;
}

function addSpreadSubject(rules, subjectId) {
    if (!subjectId) return;
    const current = rules.softRules.spreadSubjects || [];
    if (!current.includes(subjectId)) current.push(subjectId);
    rules.softRules.spreadSubjects = current;
}

function parseFirstSlot(slots = []) {
    const [first] = Array.isArray(slots) ? slots : [];
    const match = String(first || '').match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) return null;
    return {
        day: Number.parseInt(match[1], 10),
        period: Number.parseInt(match[2], 10),
    };
}

function findLockedLessonPlan(project, { classId, subjectId, teacherId }) {
    return (project.lessonPlans || []).find(plan => (
        plan.classId === classId
        && plan.subjectId === subjectId
        && (plan.teacherId === teacherId || plan.teacherIds?.includes(teacherId))
    )) || null;
}

function addLockedSlot(rules, locked) {
    if (!locked) return;
    const keyFor = item => [
        item.day,
        item.period,
        item.classId,
        item.subjectId,
        item.teacherId,
        item.lessonPlanId || '',
    ].join('|');
    const existing = new Set((rules.hardRules.lockedSlots || []).map(keyFor));
    if (!existing.has(keyFor(locked))) rules.hardRules.lockedSlots.push(locked);
}

function normalizeDraftRow(row = {}, index = 0, project = {}) {
    const type = normalizeConstraintType(row.type || row.ruleType);
    const slots = slotsFromConstraint(row, project);
    const rawText = asText(row.rawText || row.constraintText || row.text || row.description || row.reason || '', 2000);
    const status = STATUS_LABELS.has(row.status) ? row.status : SUPPORTED_EFFECTIVE_TYPES.has(type) ? 'effective' : 'suggestion';
    return {
        id: asText(row.id, 120) || `rule_draft_${index + 1}`,
        source: asText(row.source || row.sourceSheet || '', 120),
        sourceSheet: asText(row.sourceSheet || row.sheetName || '', 120),
        sourceRow: Number.parseInt(row.sourceRow, 10) || null,
        rawText,
        type,
        targetType: targetTypeFor(type, row),
        targetId: asText(row.targetId || row.teacherId || row.classId || row.subjectId || '', 120),
        targetName: asText(row.targetName || row.target || row.teacher || row.teacherName || row.class || row.className || row.subject || row.subjectName || '', 200),
        classId: asText(row.classId || '', 120),
        className: asText(row.className || row.class || '', 200),
        subjectId: asText(row.subjectId || '', 120),
        subjectName: asText(row.subjectName || row.subject || '', 200),
        teacherId: asText(row.teacherId || '', 120),
        teacherName: asText(row.teacherName || row.teacher || '', 200),
        slots,
        days: parseDays(row.days || row.weekdays || '', project, []),
        periods: parsePeriods(row.periods || row.lessonIndexes || '', project, []),
        priority: normalizePriority(row.priority || row.strength, type),
        status: status === 'ready' ? 'effective' : status,
        sourceStatus: STATUS_LABELS.has(row.status) ? row.status : '',
        confidence: row.confidence !== null && row.confidence !== undefined && Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
        description: asText(row.description || row.reason || row.note || '', 500),
        warnings: Array.isArray(row.warnings) ? row.warnings.map(item => asText(item, 200)).filter(Boolean) : [],
        ambiguity: row.ambiguity || null,
        ambiguities: Array.isArray(row.ambiguities) ? row.ambiguities : [],
        weekPattern: asText(row.weekPattern || row.week || '', 60) || weekPatternFromText(rawText),
        weight: Number.parseInt(row.weight, 10) || undefined,
        limit: Number.parseInt(row.limit ?? row.value ?? row.max ?? row.count, 10) || undefined,
    };
}

function splitGroupedTargetText(value = '') {
    const text = asText(value, 600);
    if (!/[,，、;；|\r\n]/.test(text)) return [];
    return [...new Set(text
        .split(/\s*[,，、;；|\r\n]+\s*/)
        .map(item => asText(item, 160))
        .filter(Boolean))];
}

function expandGroupedEntityTarget(row = {}, index = 0, project = {}) {
    const type = normalizeConstraintType(row.type || row.ruleType);
    const targetType = targetTypeFor(type, row);
    if (!['teacher', 'class', 'subject'].includes(targetType)) return [row];

    const specificId = targetType === 'teacher'
        ? row.teacherId
        : targetType === 'class'
            ? row.classId
            : row.subjectId;
    if (row.targetId || specificId) return [row];

    const targetText = row.targetName
        || row.target
        || (targetType === 'teacher' ? row.teacherName || row.teacher : '')
        || (targetType === 'class' ? row.className || row.class : '')
        || (targetType === 'subject' ? row.subjectName || row.subject : '');
    const parts = splitGroupedTargetText(targetText);
    if (parts.length < 2) return [row];

    const hadGroupedAmbiguity = Boolean(row.ambiguity)
        || (Array.isArray(row.ambiguities) && row.ambiguities.length > 0)
        || (row.warnings || []).some(warning => /多个候选|不会自动猜测/.test(String(warning || '')));
    const baseId = asText(row.id, 120) || `rule_draft_${index + 1}`;

    return parts.map((part, partIndex) => {
        const match = matchEntityCandidates(project, part, targetType);
        const exact = match.candidates.length === 1 && match.candidates[0].confidence >= 0.96
            ? match.candidates[0]
            : null;
        const next = {
            ...row,
            id: `${baseId}__${partIndex + 1}`,
            targetType,
            targetId: exact?.id || '',
            targetName: exact?.label || part,
            ambiguity: null,
            ambiguities: [],
            warnings: (row.warnings || []).filter(warning => !/多个候选|不会自动猜测/.test(String(warning || ''))),
            status: hadGroupedAmbiguity && row.status === 'needs_review' ? 'effective' : row.status,
        };

        if (targetType === 'teacher') {
            next.teacherId = exact?.id || '';
            next.teacherName = exact?.label || part;
        } else if (targetType === 'class') {
            next.classId = exact?.id || '';
            next.className = exact?.label || part;
        } else if (targetType === 'subject') {
            next.subjectId = exact?.id || '';
            next.subjectName = exact?.label || part;
        }
        return next;
    });
}

function validateTimeExpression(row = {}, project = {}) {
    const activeDays = new Set(getActiveWeekdays(project));
    const activePeriods = new Set(getActivePeriods(project));
    const invalidSlots = [];
    const slots = (row.slots || []).filter(slot => {
        const match = String(slot || '').match(/^(\d{1,2})-(\d{1,2})$/);
        if (!match) {
            invalidSlots.push(String(slot || ''));
            return false;
        }
        const day = Number.parseInt(match[1], 10);
        const period = Number.parseInt(match[2], 10);
        const valid = activeDays.has(day) && activePeriods.has(period);
        if (!valid) invalidSlots.push(slotKey(day, period));
        return true;
    });
    return {
        slots,
        invalidSlots,
        warnings: invalidSlots.length
            ? [`节次 ${invalidSlots.join('、')} 不在当前排课范围内。`]
            : [],
    };
}

function statusWithConfidence(row = {}, confidence = null) {
    if (row.status === 'ignored') return 'ignored';
    const value = row.confidence !== null && row.confidence !== undefined && Number.isFinite(Number(row.confidence))
        ? Number(row.confidence)
        : confidence;
    if (Number.isFinite(value) && value < 0.85 && row.status === 'effective') return 'needs_review';
    return row.status === 'ready' ? 'effective' : row.status;
}

function rowNeedsSlots(type) {
    return ['teacher_unavailable', 'class_unavailable', 'locked_slot', 'subject_preferred_periods', 'subject_avoid_periods'].includes(type);
}

function applySingleTarget(row, project, targetType) {
    const items = entityItemsForType(project, targetType);
    // 如果 targetId 已明确指向一个有效实体(如追问回填后),直接采用,无需模糊匹配
    if (row.targetId) {
        const directMatch = items.find(item => item.id === row.targetId);
        if (directMatch) {
            const label = directMatch.label || directMatch.name || row.targetName || row.targetId;
            const confidence = Math.max(
                row.confidence !== null && row.confidence !== undefined && Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.9,
                0.9,
            );
            return {
                ...row,
                targetType,
                targetId: directMatch.id,
                targetName: label,
                confidence,
                warnings: [...(row.warnings || [])],
                status: statusWithConfidence({ ...row, confidence }, confidence),
            };
        }
    }
    const match = matchEntityCandidates(project, row.targetName || row.targetId, targetType, { targetId: row.targetId });
    const warnings = [...(row.warnings || [])];
    const next = { ...row, targetType };

    if (match.candidates.length === 1 && (match.candidates[0].confidence || 0) >= 0.96) {
        const [candidate] = match.candidates;
        next.targetId = candidate.id;
        next.targetName = candidate.label;
        next.confidence = next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence))
            ? Math.min(Number(next.confidence), candidate.confidence || 1)
            : candidate.confidence || 0.9;
        return { ...next, warnings, status: statusWithConfidence(next, candidate.confidence || 0.9) };
    }

    if (match.candidates.length >= 1) {
        const ambiguity = {
            field: 'target',
            targetType,
            targetText: match.targetText || row.targetName || row.targetId || '',
            candidates: match.candidates,
        };
        warnings.push(match.candidates.length > 1
            ? `${ambiguity.targetText || '规则对象'} 存在多个候选，请确认后再生效。`
            : `${ambiguity.targetText || '规则对象'} 只有低置信候选，请确认后再生效。`);
        return {
            ...next,
            status: 'needs_review',
            confidence: Math.min(
                next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence)) ? Number(next.confidence) : 0.7,
                match.confidence || 0.7,
            ),
            ambiguity,
            ambiguities: [...(next.ambiguities || []), ambiguity],
            warnings,
        };
    }

    warnings.push(`${row.targetName || row.targetId || '规则对象'} 在当前项目中没有匹配对象。`);
    return {
        ...next,
        status: 'needs_review',
        confidence: Math.min(
            next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence)) ? Number(next.confidence) : 0.55,
            0.55,
        ),
        warnings,
    };
}

function matchLockedField(project, row, field, targetType, text, id = '') {
    const match = matchEntityCandidates(project, text || id, targetType, { targetId: id });
    if (match.candidates.length === 1) return { field, targetType, match: match.candidates[0] };
    return {
        field,
        targetType,
        targetText: match.targetText || text || id || '',
        candidates: match.candidates,
    };
}

function classifyDraftRow(row = {}, project = {}) {
    let next = { ...row, warnings: [...(row.warnings || [])] };
    const type = next.type;
    const time = validateTimeExpression(next, project);
    next = { ...next, slots: time.slots.length ? time.slots : next.slots, warnings: [...next.warnings, ...time.warnings] };

    if (next.status === 'ignored') return next;
    if (shouldNormalizeAllTeachersTarget(next, type)) {
        next = normalizeAllTeachersTargetRow(next);
    }
    if (!SUPPORTED_EFFECTIVE_TYPES.has(type)) {
        const status = SUGGESTION_ONLY_TYPES.has(type) ? 'suggestion' : 'unsupported';
        return {
            ...next,
            status,
            priority: normalizePriority(next.priority, type),
            warnings: status === 'unsupported'
                ? [...next.warnings, '当前版本只能预览这类建议，暂不会写入排课规则。']
                : next.warnings,
        };
    }

    if (time.invalidSlots.length) {
        next.status = 'invalid';
    }
    if (rowNeedsSlots(type) && !(next.slots || []).length) {
        next.status = 'needs_review';
        next.warnings.push('缺少明确节次，请补充后再生效。');
    }

    if (type === 'locked_slot') {
        const fields = [
            matchLockedField(project, next, 'teacher', 'teacher', next.teacherName || '', next.teacherId || ''),
            matchLockedField(project, next, 'class', 'class', next.className || next.targetName || '', next.classId || ''),
            matchLockedField(project, next, 'subject', 'subject', next.subjectName || '', next.subjectId || ''),
        ];
        const ambiguities = fields.filter(item => item.candidates && item.candidates.length !== 1);
        const matched = Object.fromEntries(fields.filter(item => item.match).map(item => [item.field, item.match]));

        if (ambiguities.length) {
            ambiguities.forEach(item => {
                next.warnings.push(`${item.targetText || item.field} ${item.candidates.length ? '存在多个候选' : '没有匹配对象'}，请确认。`);
            });
            return {
                ...next,
                targetType: 'locked_slot',
                status: 'needs_review',
                confidence: Math.min(
                    next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence)) ? Number(next.confidence) : 0.65,
                    0.75,
                ),
                ambiguities,
                ambiguity: ambiguities[0] || null,
            };
        }

        next.teacherId = matched.teacher.id;
        next.teacherName = matched.teacher.label;
        next.classId = matched.class.id;
        next.className = matched.class.label;
        next.subjectId = matched.subject.id;
        next.subjectName = matched.subject.label;
        next.targetType = 'locked_slot';
        next.targetId = `${next.classId}:${next.subjectId}:${next.teacherId}`;
        next.targetName = `${next.className} / ${next.subjectName} / ${next.teacherName}`;
        next.priority = 'hard';
        next.confidence = next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence)) ? Number(next.confidence) : 0.9;
        next.status = statusWithConfidence(next, 0.9);
        return next;
    }

    if ((type === 'teacher_daily_limit' || type === 'teacher_consecutive_limit') && isAllTeachersTarget(next)) {
        next.targetType = 'all_teachers';
        next.targetId = '__all_teachers';
        next.targetName = '全部教师';
        next.priority = 'soft';
        next.confidence = next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence))
            ? Number(next.confidence)
            : 0.9;
        next.status = statusWithConfidence(next, next.confidence);
    }

    const targetType = targetTypeFor(type, next);
    if (['teacher', 'class', 'subject'].includes(targetType)) {
        next = applySingleTarget(next, project, targetType);
    }

    if ((type === 'teacher_daily_limit' || type === 'teacher_consecutive_limit') && (!Number.isInteger(next.limit) || next.limit <= 0)) {
        next.status = 'needs_review';
        next.warnings.push('缺少有效的节数上限。');
    }

    if (next.confidence === null || next.confidence === undefined || !Number.isFinite(Number(next.confidence))) {
        next.confidence = next.status === 'effective' ? 0.9 : next.status === 'needs_review' ? 0.65 : 0.5;
    }
    next.status = statusWithConfidence(next, Number(next.confidence));
    if (next.weekPattern) {
        next.status = 'needs_review';
        if (!next.warnings.some(warning => /单双周|不会自动生效/.test(warning))) {
            next.warnings.push('当前规则模型暂不支持单双周，不会自动生效。');
        }
        next.confidence = Math.min(Number(next.confidence) || 0.65, 0.68);
    }
    return next;
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
    rules.softRules.teacherLimits = { ...(rules.softRules.teacherLimits || {}) };
    rules.softRules.spreadSubjects = [...(rules.softRules.spreadSubjects || [])];
    return rules;
}

function previewRows(rows = []) {
    return rows.map(previewFromRow);
}

function sourceFromRow(row = {}) {
    return {
        rawText: row.rawText || row.description || '',
        source: row.source || '',
        sourceSheet: row.sourceSheet || '',
        sourceRow: row.sourceRow || null,
    };
}

function entityObject(kind, name = '', matchedIds = [], scope = 'explicit') {
    return {
        kind,
        name: asText(name, 200),
        matchedIds: [...new Set((Array.isArray(matchedIds) ? matchedIds : [matchedIds]).map(item => asText(item, 120)).filter(Boolean))],
        scope,
    };
}

function rowRequirementObject(row = {}) {
    if (row.targetType === 'all_teachers' || isAllTeachersTarget(row)) {
        return entityObject('teacher_group', '全部教师', ['__all_teachers'], 'group');
    }
    if (row.targetType === 'teacher') return entityObject('teacher', row.targetName || row.teacherName || '教师', row.targetId || row.teacherId);
    if (row.targetType === 'class') return entityObject('class', row.targetName || row.className || '班级', row.targetId || row.classId);
    if (row.targetType === 'subject') return entityObject('subject', row.targetName || row.subjectName || '课程', row.targetId || row.subjectId);
    if (row.targetType === 'locked_slot') return entityObject('lesson_slot', row.targetName || '固定课节', row.targetId, 'explicit');
    return entityObject('global', row.targetName || row.type || '全局', row.targetId, 'global');
}

function intentForRow(row = {}) {
    const map = {
        teacher_unavailable: 'unavailable_periods',
        class_unavailable: 'unavailable_periods',
        locked_slot: 'locked_slot',
        subject_morning: 'preferred_day_part',
        subject_preferred_periods: 'preferred_periods',
        subject_avoid_periods: 'avoid_periods',
        teacher_daily_limit: 'teacher_daily_limit',
        teacher_consecutive_limit: 'teacher_consecutive_limit',
        subject_spread: 'subject_spread',
        teacher_load_balance: 'teacher_load_protection',
        block_protection: 'block_integrity',
        class_daily_balance: 'class_daily_balance',
        class_subject_spread: 'class_subject_spread',
        quality_subject_later: 'quality_subject_later',
    };
    return map[row.type] || row.type || 'unknown';
}

function applyToForRow(row = {}) {
    if (SUPPORTED_EFFECTIVE_TYPES.has(row.type)) return 'rule';
    if (row.type === 'teacher_load_balance' || row.type === 'class_daily_balance' || row.type === 'class_subject_spread') return 'optimization';
    if (row.type === 'block_protection') return 'solver_policy';
    return row.status === 'ignored' ? 'solver_policy' : 'review';
}

function requirementStatusForRow(row = {}) {
    if (row.status === 'effective') return 'actionable';
    if (row.status === 'suggestion' && ['teacher_load_balance', 'class_daily_balance', 'class_subject_spread'].includes(row.type)) return 'actionable';
    if (row.status === 'ignored' || row.type === 'block_protection') return 'handled';
    return 'needs_review';
}

function parametersForRow(row = {}) {
    return {
        ...(row.slots?.length ? { slots: row.slots } : {}),
        ...(row.days?.length ? { days: row.days } : {}),
        ...(row.periods?.length ? { periods: row.periods } : {}),
        ...(row.limit ? { limit: row.limit } : {}),
        ...(row.weight ? { weight: row.weight } : {}),
        ...(row.weekPattern ? { weekPattern: row.weekPattern } : {}),
    };
}

function requirementFromRow(row = {}, index = 0) {
    return {
        id: `req_${row.id || index + 1}`,
        rowId: row.id || '',
        object: rowRequirementObject(row),
        intent: intentForRow(row),
        condition: {
            ...(row.slots?.length ? { slots: row.slots } : {}),
            ...(row.weekPattern ? { weekPattern: row.weekPattern } : {}),
        },
        parameters: parametersForRow(row),
        strength: row.priority === 'hard' ? 'hard' : 'soft',
        status: requirementStatusForRow(row),
        applyTo: applyToForRow(row),
        confidence: row.confidence,
        source: sourceFromRow(row),
        warnings: row.warnings || [],
    };
}

function highLoadTeacherIds(project = {}, threshold = 14) {
    const hours = new Map();
    for (const plan of project.lessonPlans || []) {
        const value = Number(plan.weeklyHours || 0);
        const ids = [plan.teacherId, ...(plan.teacherIds || [])].filter(Boolean);
        ids.forEach(id => hours.set(id, (hours.get(id) || 0) + value));
    }
    return [...hours.entries()]
        .filter(([, count]) => count >= threshold)
        .map(([id]) => id);
}

function teacherNamesById(project = {}, ids = []) {
    const map = new Map((project.teachers || []).map(teacher => [teacher.id, teacher.name || teacher.id]));
    return ids.map(id => map.get(id) || id).filter(Boolean);
}

function lessonPlansForSubjectIds(project = {}, subjectIds = []) {
    const subjectSet = new Set(subjectIds);
    return (project.lessonPlans || []).filter(plan => subjectSet.has(plan.subjectId));
}

function blockPreferenceFromText(text = '') {
    if (/混合|单双|单双混排|mixed/i.test(text)) return 'mixed';
    if (/不要连堂|不连堂|避免连堂|默认单节|按单节|单节|single/i.test(text)) return 'single';
    if (/双连堂|连堂|连续两节|连排|double|block/i.test(text)) return 'double';
    return '';
}

function textRequirementBase(id, object, intent, sourceText, {
    condition = {},
    parameters = {},
    strength = 'soft',
    status = 'actionable',
    applyTo = 'review',
    confidence = 0.8,
    warnings = [],
} = {}) {
    return {
        id,
        object,
        intent,
        condition,
        parameters,
        strength,
        status,
        applyTo,
        confidence,
        source: { rawText: asText(sourceText, 1000) },
        warnings,
    };
}

function systemRequirementsFromText(text = '') {
    const requirements = [];
    const sourceText = asText(text, 1200);
    if (/同一.*教师.*同一.*时间.*(只能|一个班|一门课)|教师.*不能.*同.*时间.*(多个|两个|两个班|上课)/.test(sourceText)) {
        requirements.push(textRequirementBase(
            'req_system_teacher_time_conflict',
            entityObject('global', '全部教师', [], 'global'),
            'teacher_time_conflict',
            sourceText,
            {
                strength: 'hard',
                status: 'handled',
                applyTo: 'solver_policy',
                confidence: 0.98,
                warnings: ['这是系统内置硬规则，求解时已自动处理。'],
            },
        ));
    }
    if (/同一.*班级.*同一.*时间.*(只能|一门|一节)|班级.*不能.*同.*时间.*(多个|两门|两节)/.test(sourceText)) {
        requirements.push(textRequirementBase(
            'req_system_class_time_conflict',
            entityObject('global', '全部班级', [], 'global'),
            'class_time_conflict',
            sourceText,
            {
                strength: 'hard',
                status: 'handled',
                applyTo: 'solver_policy',
                confidence: 0.98,
                warnings: ['这是系统内置硬规则，求解时已自动处理。'],
            },
        ));
    }
    if (/未注明.*默认.*单节|默认.*单节|没有.*连堂.*单节/.test(sourceText)) {
        requirements.push(textRequirementBase(
            'req_system_default_single',
            entityObject('global', '默认课时块策略', [], 'global'),
            'default_block_policy',
            sourceText,
            {
                parameters: { blockPreference: 'single' },
                strength: 'default',
                status: 'handled',
                applyTo: 'solver_policy',
                confidence: 0.95,
                warnings: ['未指定连堂的任课计划默认按单节处理。'],
            },
        ));
    }
    if (/连堂块.*(不能|不可|不要|不应).*(拆|拆开|打散)|连堂.*(保护|整段|整块)|块.*完整/.test(sourceText)) {
        requirements.push(textRequirementBase(
            'req_system_block_integrity',
            entityObject('lesson_block', '所有连堂课时块', [], 'global'),
            'block_integrity',
            sourceText,
            {
                strength: 'hard',
                status: 'handled',
                applyTo: 'solver_policy',
                confidence: 0.94,
                warnings: ['连堂课时块在求解和修复中按整段处理。'],
            },
        ));
    }
    return requirements;
}

function blockPreferenceRequirementsFromText(project = {}, text = '') {
    const requirements = [];
    splitSentences(text).forEach((sentenceGroup, groupIndex) => {
        splitClauses(sentenceGroup).forEach((sentence, clauseIndex) => {
            if (!/(连堂|连排|连续两节|双连堂|单节|混合|单双)/.test(sentence)) return;
            if (/默认.*单节|未注明.*单节/.test(sentence)) return;
            const blockPreference = blockPreferenceFromText(sentence);
            if (!blockPreference) return;
            const subjects = textSubjectTargets(sentence, project);
            const idBase = `req_block_${groupIndex + 1}_${clauseIndex + 1}`;
            if (!subjects.length) {
                requirements.push(textRequirementBase(
                    idBase,
                    entityObject('subject', '未明确课程', [], 'unknown'),
                    'block_preference',
                    sentence,
                    {
                        parameters: { blockPreference },
                        strength: /必须|要求|不能|不要/.test(sentence) ? 'hard' : 'soft',
                        status: 'needs_review',
                        applyTo: 'lesson_plan',
                        confidence: 0.62,
                        warnings: ['缺少明确课程，不能直接修改任课计划。'],
                    },
                ));
                return;
            }
            subjects.forEach((subject, subjectIndex) => {
                const subjectIds = subject.id ? [subject.id] : [];
                const plans = lessonPlansForSubjectIds(project, subjectIds);
                requirements.push(textRequirementBase(
                    `${idBase}_${subjectIndex + 1}`,
                    entityObject('subject', subject.name, subjectIds, subject.id ? 'explicit' : 'unknown'),
                    'block_preference',
                    sentence,
                    {
                        parameters: {
                            blockPreference,
                            lessonPlanIds: plans.map(plan => plan.id),
                        },
                        strength: /必须|要求|不能|不要/.test(sentence) ? 'hard' : 'soft',
                        status: subject.id && plans.length ? 'actionable' : 'needs_review',
                        applyTo: 'lesson_plan',
                        confidence: subject.id ? 0.9 : 0.64,
                        warnings: plans.length ? [] : ['没有找到可修改的任课计划，请先确认任课数据。'],
                    },
                ));
            });
        });
    });
    return requirements;
}

function optimizationRequirementsFromText(project = {}, text = '') {
    const sourceText = asText(text, 1200);
    const requirements = [];
    if (/高负载教师|教师.*负载|负载.*教师|连续.*太多|不要.*连续.*太多/.test(sourceText)) {
        const teacherIds = highLoadTeacherIds(project);
        const names = teacherIds.length ? teacherNamesById(project, teacherIds).join('、') : '高负载教师';
        requirements.push(textRequirementBase(
            'req_optimization_high_load_teachers',
            entityObject('derived_group', names, teacherIds, 'derived'),
            'teacher_load_protection',
            sourceText,
            {
                parameters: { maxConsecutive: 3, balancedTeacherLoad: true },
                strength: 'soft',
                status: 'actionable',
                applyTo: 'optimization',
                confidence: teacherIds.length ? 0.88 : 0.78,
                warnings: teacherIds.length ? [] : ['当前数据未识别出达到高负载阈值的教师，将先启用教师负载均衡目标。'],
            },
        ));
    }
    if (/班级.*(每天|每日).*(均衡|平衡)|班级.*(均衡|平衡).*(每天|每日)/.test(sourceText)) {
        requirements.push(textRequirementBase(
            'req_optimization_class_daily_balance',
            entityObject('global', '全部班级', [], 'global'),
            'class_daily_balance',
            sourceText,
            {
                strength: 'soft',
                status: 'handled',
                applyTo: 'optimization',
                confidence: 0.82,
                warnings: ['班级每日均衡已纳入课表质量评分。'],
            },
        ));
    }
    return requirements;
}

function externalRequirementItems(items = []) {
    return (Array.isArray(items) ? items : []).map((item, index) => ({
        id: asText(item.id, 120) || `req_external_${index + 1}`,
        object: item.object && typeof item.object === 'object'
            ? {
                kind: asText(item.object.kind || item.object.type || 'global', 80),
                name: asText(item.object.name || item.object.label || item.targetName || item.target || '', 200),
                matchedIds: Array.isArray(item.object.matchedIds) ? item.object.matchedIds.map(value => asText(value, 120)).filter(Boolean) : [],
                scope: asText(item.object.scope || 'explicit', 80),
            }
            : entityObject(asText(item.targetType || 'global', 80), asText(item.targetName || item.target || '', 200), item.targetId || '', 'explicit'),
        intent: asText(item.intent || item.type || 'unknown', 120),
        condition: item.condition && typeof item.condition === 'object' ? item.condition : {},
        parameters: item.parameters && typeof item.parameters === 'object' ? item.parameters : {},
        strength: asText(item.strength || item.priority || 'soft', 40),
        status: asText(item.status || 'needs_review', 40),
        applyTo: asText(item.applyTo || 'review', 80),
        confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
        source: item.source && typeof item.source === 'object' ? item.source : { rawText: asText(item.rawText || item.reason || item.description || '', 1000) },
        warnings: Array.isArray(item.warnings) ? item.warnings.map(value => asText(value, 240)).filter(Boolean) : [],
    }));
}

function dedupeRequirements(items = []) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
        const key = JSON.stringify([
            item.intent,
            item.applyTo,
            item.status,
            item.object?.kind,
            item.object?.name,
            item.object?.matchedIds || [],
            item.parameters || {},
            item.source?.rawText || '',
        ]);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ ...item, id: item.id || `req_${result.length + 1}` });
    }
    return result;
}

function actionForRequirement(project = {}, requirement = {}, index = 0) {
    if (requirement.status === 'handled') {
        return {
            id: `act_${requirement.id || index + 1}`,
            requirementId: requirement.id,
            kind: 'handled_notice',
            status: 'handled',
            applyTo: requirement.applyTo,
        };
    }
    if (requirement.status !== 'actionable') return null;
    if (requirement.applyTo === 'lesson_plan' && requirement.intent === 'block_preference') {
        const lessonPlanIds = requirement.parameters?.lessonPlanIds?.length
            ? requirement.parameters.lessonPlanIds
            : lessonPlansForSubjectIds(project, requirement.object?.matchedIds || []).map(plan => plan.id);
        return {
            id: `act_${requirement.id || index + 1}`,
            requirementId: requirement.id,
            kind: 'lesson_plan_patch',
            target: {
                subjectIds: requirement.object?.matchedIds || [],
                lessonPlanIds,
            },
            patch: { blockPreference: requirement.parameters?.blockPreference },
            status: lessonPlanIds.length ? 'ready' : 'needs_review',
            requiresConfirmation: true,
        };
    }
    if (requirement.applyTo === 'optimization' && requirement.intent === 'teacher_load_protection') {
        return {
            id: `act_${requirement.id || index + 1}`,
            requirementId: requirement.id,
            kind: 'soft_rules_patch',
            target: { teacherIds: requirement.object?.matchedIds || [], derivedGroup: 'high_load_teachers' },
            patch: {
                balancedTeacherLoad: true,
                teacherLimits: { consecutive: requirement.parameters?.maxConsecutive || 3 },
            },
            status: 'ready',
            requiresConfirmation: true,
        };
    }
    if (requirement.applyTo === 'rule' && requirement.rowId) {
        return {
            id: `act_${requirement.id || index + 1}`,
            requirementId: requirement.id,
            kind: 'rules_patch',
            target: { rowIds: [requirement.rowId] },
            status: 'ready',
            requiresConfirmation: true,
        };
    }
    return null;
}

function buildRequirementSemantics(project = {}, rows = [], {
    originalText = '',
    semanticRequirements = [],
} = {}) {
    const textRequirements = [
        ...systemRequirementsFromText(originalText),
        ...blockPreferenceRequirementsFromText(project, originalText),
        ...optimizationRequirementsFromText(project, originalText),
    ];
    const rowRequirements = rows.map(requirementFromRow);
    const requirementItems = dedupeRequirements([
        ...externalRequirementItems(semanticRequirements),
        ...textRequirements,
        ...rowRequirements,
    ]);
    const semanticActions = requirementItems
        .map((requirement, index) => actionForRequirement(project, requirement, index))
        .filter(Boolean);
    return { requirementItems, semanticActions };
}

export function applyTimetableRequirementActions({
    project: inputProject = {},
    actions = [],
} = {}) {
    const project = normalizeTimetableProject(inputProject);
    const next = normalizeTimetableProject({
        ...project,
        lessonPlans: (project.lessonPlans || []).map(plan => ({ ...plan })),
        rules: cloneValue(project.rules || {}),
    });
    next.rules = emptyRulesFrom(next);
    const applied = [];
    const skipped = [];
    const needsReview = [];

    const actionList = Array.isArray(actions) ? actions : [];
    for (const action of actionList) {
        const id = asText(action?.id, 120) || `action_${applied.length + skipped.length + needsReview.length + 1}`;
        const kind = asText(action?.kind, 80);
        if (action?.status && !['ready', 'actionable'].includes(action.status)) {
            skipped.push({ id, kind, reason: '动作尚未确认或不可应用。' });
            continue;
        }

        if (kind === 'lesson_plan_patch') {
            const blockPreference = asText(action.patch?.blockPreference, 40);
            if (!['single', 'double', 'mixed'].includes(blockPreference)) {
                needsReview.push({ id, kind, reason: '缺少有效连堂设置。' });
                continue;
            }
            const explicitPlanIds = new Set((action.target?.lessonPlanIds || []).map(value => asText(value, 120)).filter(Boolean));
            const subjectIds = new Set((action.target?.subjectIds || []).map(value => asText(value, 120)).filter(Boolean));
            const targets = next.lessonPlans.filter(plan => explicitPlanIds.has(plan.id) || (!explicitPlanIds.size && subjectIds.has(plan.subjectId)));
            if (!targets.length) {
                needsReview.push({ id, kind, reason: '没有找到可修改的任课计划。' });
                continue;
            }
            targets.forEach(plan => {
                plan.blockPreference = blockPreference;
            });
            applied.push({ id, kind, count: targets.length });
            continue;
        }

        if (kind === 'soft_rules_patch') {
            let changed = false;
            next.rules.softRules = next.rules.softRules || {};
            if (action.patch?.balancedTeacherLoad !== undefined) {
                next.rules.softRules.balancedTeacherLoad = action.patch.balancedTeacherLoad !== false;
                changed = true;
            }
            const teacherLimitPatch = action.patch?.teacherLimits || {};
            const hasTeacherLimitPatch = Number.isInteger(Number(teacherLimitPatch.daily))
                || Number.isInteger(Number(teacherLimitPatch.consecutive));
            if (hasTeacherLimitPatch) {
                const teacherIds = (action.target?.teacherIds || []).map(value => asText(value, 120)).filter(Boolean);
                const validTeacherIds = new Set((next.teachers || []).map(teacher => teacher.id));
                const matched = teacherIds.filter(idValue => validTeacherIds.has(idValue));
                const missing = teacherIds.filter(idValue => !validTeacherIds.has(idValue));
                matched.forEach(teacherId => addTeacherLimit(next.rules, teacherId, {
                    daily: Number.isInteger(Number(teacherLimitPatch.daily)) ? Number(teacherLimitPatch.daily) : undefined,
                    consecutive: Number.isInteger(Number(teacherLimitPatch.consecutive)) ? Number(teacherLimitPatch.consecutive) : undefined,
                }));
                if (matched.length) changed = true;
                if (missing.length) {
                    needsReview.push({ id, kind, reason: `教师 ${missing.join('、')} 不存在，未写入这些对象。` });
                }
                if (!matched.length && teacherIds.length) {
                    continue;
                }
            }
            const spreadSubjectIds = (action.patch?.spreadSubjectIds || action.target?.subjectIds || []).map(value => asText(value, 120)).filter(Boolean);
            if (spreadSubjectIds.length && action.patch?.spreadSubjects !== false) {
                const validSubjectIds = new Set((next.subjects || []).map(subject => subject.id));
                spreadSubjectIds.filter(subjectId => validSubjectIds.has(subjectId)).forEach(subjectId => addSpreadSubject(next.rules, subjectId));
                changed = true;
            }
            if (changed) {
                applied.push({ id, kind });
            } else {
                needsReview.push({ id, kind, reason: '没有可写入的优化目标参数。' });
            }
            continue;
        }

        if (kind === 'rules_patch') {
            skipped.push({ id, kind, reason: '规则类动作请继续通过现有规则应用流程写入。' });
            continue;
        }

        if (kind === 'handled_notice') {
            skipped.push({ id, kind, reason: '该需求已由系统自动处理。' });
            continue;
        }

        skipped.push({ id, kind, reason: '未知语义动作类型。' });
    }

    return {
        project: normalizeTimetableProject(next),
        applied,
        skipped,
        needsReview,
    };
}

function confidenceBucket(row = {}) {
    const value = Number(row.confidence);
    if (Number.isFinite(value) && value >= 0.85) return 'high';
    if (Number.isFinite(value) && value >= 0.65) return 'medium';
    return 'low';
}

function confidenceSummary(rows = []) {
    return rows.reduce((summary, row) => {
        summary[confidenceBucket(row)] += 1;
        return summary;
    }, { high: 0, medium: 0, low: 0 });
}

function buildMissingInfo(rows = []) {
    const items = [];
    rows.forEach((row, index) => {
        if (!['needs_review', 'invalid'].includes(row.status)) return;
        const text = row.targetName || row.targetId || row.className || row.teacherName || row.subjectName || row.rawText || '规则对象';
        const hasCandidates = (row.ambiguities || []).some(item => (item.candidates || []).length);
        if (hasCandidates) return;
        if (!row.warnings?.length && row.status !== 'invalid') return;
        items.push({
            id: `missing_${index + 1}`,
            message: row.warnings?.[0] || `${text} 信息不完整，请补充。`,
            relatedRuleIds: [row.id],
        });
    });
    return items;
}

function buildClarifyingQuestions(project = {}, rows = []) {
    const questions = [];
    const questionMap = new Map();
    rows.forEach(row => {
        if (isAllTeachersTarget(row)) return;
        const ambiguityMap = new Map();
        [...(row.ambiguities || []), row.ambiguity].filter(Boolean).forEach(item => {
            if (isAllTeachersTarget({
                targetId: item.targetId,
                targetName: item.targetText,
                target: item.target,
                rawText: item.targetText,
            })) return;
            const key = JSON.stringify([
                item.field || '',
                item.targetType || '',
                item.targetText || '',
                (item.candidates || []).map(candidate => candidate.id || candidate.value || candidate.label).sort(),
            ]);
            if (!ambiguityMap.has(key)) ambiguityMap.set(key, item);
        });
        const ambiguities = [...ambiguityMap.values()];
        ambiguities.forEach((ambiguity, index) => {
            const seenOptions = new Set();
            const options = (ambiguity.candidates || []).map(candidate => ({
                label: asText(candidate.label || candidate.name || candidate.value || candidate.id, 120),
                value: asText(candidate.id || candidate.value, 120),
            })).filter(option => {
                if (!option.label || !option.value || seenOptions.has(option.value)) return false;
                seenOptions.add(option.value);
                return true;
            });
            if (!options.length) return;
            const targetText = ambiguity.targetText || row.targetName || row.rawText || '这个对象';
            const typeLabel = {
                teacher: '老师',
                class: '班级',
                subject: '课程',
            }[ambiguity.targetType] || '对象';
            questions.push({
                id: `q_${row.id}_${ambiguity.field || index}`,
                question: `你说的${targetText}是哪一个${typeLabel}？`,
                reason: `存在多个可匹配的${typeLabel}，系统不会自动猜测。`,
                targetType: ambiguity.targetType || row.targetType || '',
                targetText,
                options,
                relatedRuleIds: [row.id],
            });
        });
    });
    const merged = [];
    questions.forEach(question => {
        const key = JSON.stringify([
            question.question || '',
            (question.options || []).map(option => option.value || option.id || option.label).sort(),
        ]);
        const existing = questionMap.get(key);
        if (existing) {
            existing.relatedRuleIds = [...new Set([...(existing.relatedRuleIds || []), ...(question.relatedRuleIds || [])].filter(Boolean))];
            return;
        }
        questionMap.set(key, question);
        merged.push(question);
    });
    return merged;
}

function detectRuleConflicts(project = {}, draftRows = []) {
    const conflicts = [];
    const teacherUnavailable = new Map();
    const classUnavailable = new Map();
    const subjectAvoid = new Map();
    const teacherLimits = new Map();
    const locked = [];

    const addMapSlots = (map, id, slots = [], ruleId = '') => {
        if (!id) return;
        const current = map.get(id) || [];
        slots.forEach(slot => current.push({ slot, ruleId }));
        map.set(id, current);
    };

    Object.entries(project.rules?.hardRules?.teacherUnavailable || {}).forEach(([teacherId, slots]) => addMapSlots(teacherUnavailable, teacherId, slots, 'saved_teacher_unavailable'));
    Object.entries(project.rules?.hardRules?.classUnavailable || {}).forEach(([classId, slots]) => addMapSlots(classUnavailable, classId, slots, 'saved_class_unavailable'));
    Object.entries(project.rules?.softRules?.subjectPreferredPeriods || {}).forEach(([subjectId, rule]) => addMapSlots(subjectAvoid, subjectId, rule?.avoid || [], 'saved_subject_avoid'));
    Object.entries(project.rules?.softRules?.teacherLimits || {}).forEach(([teacherId, limits]) => {
        if (Number.isInteger(Number(limits?.daily))) teacherLimits.set(teacherId, { limit: Number(limits.daily), ruleId: 'saved_teacher_daily_limit' });
    });
    (project.rules?.hardRules?.lockedSlots || []).forEach((slot, index) => locked.push({
        id: `saved_locked_${index + 1}`,
        teacherId: slot.teacherId,
        classId: slot.classId,
        subjectId: slot.subjectId,
        slot: slotKey(slot.day, slot.period),
    }));

    draftRows.filter(row => row.status === 'effective').forEach(row => {
        if (row.type === 'teacher_unavailable') addMapSlots(teacherUnavailable, row.targetId, row.slots, row.id);
        if (row.type === 'class_unavailable') addMapSlots(classUnavailable, row.targetId, row.slots, row.id);
        if (row.type === 'subject_avoid_periods') addMapSlots(subjectAvoid, row.targetId, row.slots, row.id);
        if (row.type === 'teacher_daily_limit') {
            if (isAllTeachersTarget(row)) {
                (project.teachers || []).forEach(teacher => {
                    teacherLimits.set(teacher.id, { limit: row.limit, ruleId: row.id });
                });
            } else {
                teacherLimits.set(row.targetId, { limit: row.limit, ruleId: row.id });
            }
        }
        if (row.type === 'locked_slot') {
            const [slot] = row.slots || [];
            if (slot) locked.push({
                id: row.id,
                teacherId: row.teacherId,
                classId: row.classId,
                subjectId: row.subjectId,
                slot,
            });
        }
    });

    const lockedByTeacherSlot = new Map();
    const lockedByClassSlot = new Map();
    locked.forEach(item => {
        const teacherKey = `${item.teacherId}|${item.slot}`;
        const classKey = `${item.classId}|${item.slot}`;
        lockedByTeacherSlot.set(teacherKey, [...(lockedByTeacherSlot.get(teacherKey) || []), item]);
        lockedByClassSlot.set(classKey, [...(lockedByClassSlot.get(classKey) || []), item]);
    });

    lockedByTeacherSlot.forEach(items => {
        const uniqueClasses = new Set(items.map(item => item.classId));
        if (items.length > 1 && uniqueClasses.size > 1) {
            conflicts.push({
                level: 'blocking',
                message: '同一老师在同一节被多个锁定课节占用。',
                relatedRuleIds: items.map(item => item.id),
                suggestion: '请只保留其中一个锁定课节，或更换教师/节次。',
            });
        }
    });
    lockedByClassSlot.forEach(items => {
        const uniqueSubjects = new Set(items.map(item => item.subjectId));
        if (items.length > 1 && uniqueSubjects.size > 1) {
            conflicts.push({
                level: 'blocking',
                message: '同一班级同一节被多个课程锁定。',
                relatedRuleIds: items.map(item => item.id),
                suggestion: '请取消重复锁定，或改到不同节次。',
            });
        }
    });

    locked.forEach(item => {
        const teacherBlocked = (teacherUnavailable.get(item.teacherId) || []).filter(rule => rule.slot === item.slot);
        teacherBlocked.forEach(rule => conflicts.push({
            level: 'blocking',
            message: '老师不可排时间与锁定课节冲突。',
            relatedRuleIds: [item.id, rule.ruleId].filter(Boolean),
            suggestion: '请取消其中一个硬约束，或把锁定课节改到可用时间。',
        }));
        const classBlocked = (classUnavailable.get(item.classId) || []).filter(rule => rule.slot === item.slot);
        classBlocked.forEach(rule => conflicts.push({
            level: 'blocking',
            message: '班级不可排时间与锁定课节冲突。',
            relatedRuleIds: [item.id, rule.ruleId].filter(Boolean),
            suggestion: '请取消其中一个硬约束，或调整班级不可排时间。',
        }));
        const subjectAvoided = (subjectAvoid.get(item.subjectId) || []).filter(rule => rule.slot === item.slot);
        subjectAvoided.forEach(rule => conflicts.push({
            level: 'warning',
            message: '课程避开节次与锁定课节存在偏好冲突。',
            relatedRuleIds: [item.id, rule.ruleId].filter(Boolean),
            suggestion: '如果必须锁定，可保留；否则建议调整避开节次或锁定节次。',
        }));
    });

    teacherLimits.forEach(({ limit, ruleId }, teacherId) => {
        if (!Number.isInteger(Number(limit)) || Number(limit) <= 0) return;
        const lockedByDay = new Map();
        locked.filter(item => item.teacherId === teacherId).forEach(item => {
            const day = String(item.slot).split('-')[0];
            lockedByDay.set(day, [...(lockedByDay.get(day) || []), item]);
        });
        lockedByDay.forEach(items => {
            if (items.length > Number(limit)) {
                conflicts.push({
                    level: 'blocking',
                    message: '教师每日最多节数小于已有硬锁定课节数。',
                    relatedRuleIds: [ruleId, ...items.map(item => item.id)].filter(Boolean),
                    suggestion: '请放宽教师每日上限，或减少当天锁定课节。',
                });
            }
        });
    });

    const seen = new Set();
    return conflicts.filter(conflict => {
        const key = JSON.stringify([conflict.level, conflict.message, conflict.relatedRuleIds]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function createRuleReport(sourceKind = 'rules') {
    const entries = [];
    const seen = new Set();
    const add = (category, { source = null, field = '', reason = '', originalValue } = {}) => {
        const key = JSON.stringify([category, source, field, reason]);
        if (seen.has(key)) return null;
        seen.add(key);
        const entry = { category, source, field, reason };
        if (originalValue !== undefined) entry.originalValue = originalValue;
        entries.push(entry);
        return entry;
    };
    return {
        kept: info => add('kept', info),
        degraded: info => add('degraded', info),
        dropped: info => add('dropped', info),
        review: info => add('review', info),
        toJSON() {
            const summary = { total: entries.length, kept: 0, degraded: 0, dropped: 0, review: 0 };
            entries.forEach(entry => {
                if (summary[entry.category] !== undefined) summary[entry.category] += 1;
            });
            return {
                sourceKind,
                summary,
                entries: entries.slice(),
                hasIssues: entries.some(entry => entry.category !== 'kept'),
            };
        },
    };
}

function ruleReportSource(row = {}, inputType = '') {
    return {
        rowId: row.id || null,
        inputType: inputType || null,
    };
}

function ruleReportLabel(row = {}) {
    return row.targetName || row.targetId || row.teacherName || row.className || row.subjectName || row.rawText || row.type || '规则';
}

function buildTimetableRuleReport({
    rows = [],
    autoAcceptable = [],
    needReview = [],
    unsupportedItems = [],
    clarifyingQuestions = [],
    missingInfo = [],
    conflicts = [],
    warnings = [],
    inputType = '',
} = {}) {
    const report = createRuleReport('rules');
    const autoIds = new Set(autoAcceptable.map(row => row.id).filter(Boolean));
    const needReviewIds = new Set(needReview.map(row => row.id).filter(Boolean));
    const unsupportedIds = new Set(unsupportedItems.map(row => row.id).filter(Boolean));

    autoAcceptable.forEach(row => report.kept({
        source: ruleReportSource(row, inputType),
        field: row.type || 'rule',
        reason: `${ruleReportLabel(row)} 高置信度规则，可确认后写入。`,
    }));

    needReview.forEach(row => {
        const category = row.status === 'invalid' || row.sourceStatus === 'invalid' ? 'dropped' : 'review';
        report[category]({
            source: ruleReportSource(row, inputType),
            field: row.type || 'rule',
            reason: (row.warnings || [])[0] || `${ruleReportLabel(row)} 需要复核后才能生效。`,
        });
    });

    unsupportedItems.forEach(row => report.degraded({
        source: ruleReportSource(row, inputType),
        field: row.type || 'rule',
        reason: row.description || row.message || `${ruleReportLabel(row)} 当前只能作为建议展示，不会直接写入规则。`,
    }));

    rows.forEach(row => {
        if (!row.id || autoIds.has(row.id) || needReviewIds.has(row.id) || unsupportedIds.has(row.id)) return;
        if (row.status === 'invalid') {
            report.dropped({
                source: ruleReportSource(row, inputType),
                field: row.type || 'rule',
                reason: (row.warnings || [])[0] || `${ruleReportLabel(row)} 无法应用，请删除或重写。`,
            });
        } else if (row.status === 'suggestion' || row.status === 'unsupported') {
            report.degraded({
                source: ruleReportSource(row, inputType),
                field: row.type || 'rule',
                reason: (row.warnings || [])[0] || `${ruleReportLabel(row)} 当前只能作为建议展示，不会直接写入规则。`,
            });
        } else if (row.status === 'needs_review') {
            report.review({
                source: ruleReportSource(row, inputType),
                field: row.type || 'rule',
                reason: (row.warnings || [])[0] || `${ruleReportLabel(row)} 需要复核后才能生效。`,
            });
        }
    });

    clarifyingQuestions.forEach(question => report.review({
        source: { rowId: (question.relatedRuleIds || [])[0] || null, inputType: inputType || null },
        field: question.targetType || 'clarifying_question',
        reason: question.reason || question.question || '需要补充信息后才能继续。',
    }));

    missingInfo.forEach(item => report.review({
        source: { rowId: (item.relatedRuleIds || [])[0] || null, inputType: inputType || null },
        field: item.targetType || 'missing_info',
        reason: item.message || '缺少必要信息，需要复核。',
    }));

    conflicts.forEach(item => {
        const category = item.level === 'blocking' || item.severity === 'blocking' ? 'dropped' : 'review';
        report[category]({
            source: { rowId: (item.relatedRuleIds || [])[0] || null, inputType: inputType || null },
            field: 'conflict',
            reason: item.message || item.suggestion || '规则之间存在冲突。',
        });
    });

    warnings.forEach(item => report.review({
        source: { rowId: null, inputType: inputType || null },
        field: 'warning',
        reason: item,
    }));

    return report.toJSON();
}

function buildRuleReviewResult({
    project,
    rows,
    warnings = [],
    unsupportedItems = [],
    source,
    inputType,
    contextStats,
    draftRules,
    previewItems,
    requirementItems = [],
    semanticActions = [],
}) {
    const conflicts = detectRuleConflicts(project, rows);
    const clarifyingQuestions = buildClarifyingQuestions(project, rows);
    const missingInfo = buildMissingInfo(rows);
    const blockingRuleIds = new Set(conflicts.filter(item => item.level === 'blocking').flatMap(item => item.relatedRuleIds || []));
    const autoAcceptable = rows.filter(row => (
        row.status === 'effective'
        && SUPPORTED_EFFECTIVE_TYPES.has(row.type)
        && Number(row.confidence || 0) >= 0.85
        && !(row.warnings || []).length
        && !(row.ambiguity || (row.ambiguities || []).length)
        && !blockingRuleIds.has(row.id)
    ));
    const needReview = rows.filter(row => (
        ['needs_review', 'invalid'].includes(row.status)
        || (
            SUPPORTED_EFFECTIVE_TYPES.has(row.type)
            && row.status === 'effective'
            && (
                Number(row.confidence || 0) < 0.85
                || (row.warnings || []).length
                || row.ambiguity
                || (row.ambiguities || []).length
            )
        )
    ));
    const nextAction = clarifyingQuestions.length || missingInfo.length
        ? 'ask_user'
        : !rows.length && !requirementItems.length
            ? 'no_result'
            : conflicts.some(item => item.level === 'blocking') || needReview.length || unsupportedItems.length || autoAcceptable.length < rows.filter(row => row.status === 'effective').length
                ? 'review'
                : 'ready_to_apply';
    const ruleReport = buildTimetableRuleReport({
        rows,
        autoAcceptable,
        needReview,
        unsupportedItems,
        clarifyingQuestions,
        missingInfo,
        conflicts,
        warnings,
        inputType,
    });

    return {
        draftRules,
        draftRows: rows,
        previewItems,
        requirementItems,
        semanticActions,
        autoAcceptable,
        needReview,
        clarifyingQuestions,
        missingInfo,
        conflicts,
        warnings,
        unsupportedItems,
        ruleReport,
        confidenceSummary: confidenceSummary(rows),
        nextAction,
        source,
        inputType,
        contextStats,
    };
}

function splitParseResult(options = {}) {
    return buildRuleReviewResult(options);
}

function applyClarifyingAnswers(draftRows = [], answers = []) {
    const byQuestion = new Map((Array.isArray(answers) ? answers : []).map(answer => [
        asText(answer.questionId || answer.id, 160),
        answer,
    ]));
    if (!byQuestion.size) return draftRows;
    return draftRows.map(row => {
        const next = cloneValue(row);
        const ambiguities = [...(next.ambiguities || []), next.ambiguity].filter(Boolean);
        for (const ambiguity of ambiguities) {
            const questionId = `q_${next.id}_${ambiguity.field || 'target'}`;
            const answer = byQuestion.get(questionId);
            if (!answer?.value) continue;
            const selected = (ambiguity.candidates || []).find(candidate => candidate.id === answer.value || candidate.value === answer.value) || {
                id: answer.value,
                value: answer.value,
                label: answer.label,
                name: answer.label,
            };
            if (ambiguity.field === 'teacher' || ambiguity.targetType === 'teacher') {
                next.teacherId = selected.id || selected.value;
                next.teacherName = selected.label || selected.name || answer.label || answer.value;
                if (next.targetType === 'teacher') {
                    next.targetId = next.teacherId;
                    next.targetName = next.teacherName;
                }
            } else if (ambiguity.field === 'class' || ambiguity.targetType === 'class') {
                next.classId = selected.id || selected.value;
                next.className = selected.label || selected.name || answer.label || answer.value;
                if (next.targetType === 'class') {
                    next.targetId = next.classId;
                    next.targetName = next.className;
                }
            } else if (ambiguity.field === 'subject' || ambiguity.targetType === 'subject') {
                next.subjectId = selected.id || selected.value;
                next.subjectName = selected.label || selected.name || answer.label || answer.value;
                if (next.targetType === 'subject') {
                    next.targetId = next.subjectId;
                    next.targetName = next.subjectName;
                }
            }
            next.ambiguity = null;
            next.ambiguities = [];
            next.status = 'effective';
            next.confidence = Math.max(Number(next.confidence) || 0, 0.88);
            next.warnings = (next.warnings || []).filter(warning => !/多个候选|请确认/.test(warning));
        }
        return next;
    });
}

export function continueTimetableRuleConversation({
    project: inputProject = {},
    draftRows = [],
    answers = [],
    inputType = 'clarification',
    contextStats = null,
    originalText = '',
    previousResult = null,
} = {}) {
    const project = normalizeTimetableProject(inputProject);
    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: applyClarifyingAnswers(draftRows, answers),
        source: 'clarification',
        inputType,
        contextStats,
    });
    return {
        ...result,
        originalText,
        answers,
        previousResult,
    };
}

function nameById(items = [], id = '', fallback = '') {
    const item = (items || []).find(entry => entry.id === id);
    return item?.name || entityLabel(item) || fallback || id;
}

export function diagnoseTimetableRules({
    project: inputProject = {},
    draftRows = [],
    solverFailure = null,
} = {}) {
    const project = normalizeTimetableProject(inputProject);
    const normalized = normalizeTimetableRuleDraftRows({
        project,
        draftRows,
        source: 'diagnose',
        inputType: 'diagnose',
    });
    const teacherUnavailable = Object.entries(project.rules?.hardRules?.teacherUnavailable || {})
        .map(([teacherId, slots]) => ({
            label: `${nameById(project.teachers, teacherId)}：${(slots || []).length} 个不可排节次`,
            count: (slots || []).length,
        }))
        .sort((left, right) => right.count - left.count);
    const classUnavailable = Object.entries(project.rules?.hardRules?.classUnavailable || {})
        .map(([classId, slots]) => ({
            label: `${nameById(project.classes, classId)}：${(slots || []).length} 个不可排节次`,
            count: (slots || []).length,
        }))
        .sort((left, right) => right.count - left.count);
    const blockingRules = [
        ...normalized.conflicts.filter(item => item.level === 'blocking').map(item => item.message),
        ...teacherUnavailable.filter(item => item.count >= Math.max(3, getActivePeriods(project).length - 1)).map(item => item.label),
        ...classUnavailable.filter(item => item.count >= Math.max(3, getActivePeriods(project).length - 1)).map(item => item.label),
    ];
    const suggestedRelaxations = blockingRules.length
        ? [
            '优先检查硬性不可排、锁定课节和教师每日上限。',
            '非必须的时间偏好建议改为软约束，或缩小到更少节次。',
        ]
        : ['当前没有发现明显规则级无解风险，可继续试排并查看质量建议。'];
    return {
        summary: blockingRules.length
            ? '当前无解风险主要来自硬性约束过强或锁定课节冲突。'
            : (solverFailure?.message || solverFailure?.reason)
                ? '暂未发现明确规则冲突，建议结合求解失败详情继续检查。'
                : '当前约束没有明显无解风险。',
        blockingRules,
        suggestedRelaxations,
        questions: normalized.clarifyingQuestions || [],
        conflicts: normalized.conflicts || [],
    };
}

export function normalizeTimetableRuleDraftRows({
    project: inputProject = {},
    draftRows = [],
    source = 'review',
    inputType = 'review',
    contextStats = null,
    initialWarnings = [],
    originalText = '',
    semanticRequirements = [],
} = {}) {
    const project = normalizeTimetableProject(inputProject);
    const rules = emptyRulesFrom(project);
    const warnings = [...initialWarnings].map(item => asText(item, 240)).filter(Boolean);
    const unsupportedItems = [];

    const rows = (Array.isArray(draftRows) ? draftRows : [])
        .flatMap((row, index) => expandGroupedEntityTarget(row, index, project))
        .map((row, index) => classifyDraftRow(normalizeDraftRow(row, index, project), project))
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

            if (row.type === 'locked_slot') {
                const classTarget = findEntity(project.classes, {
                    targetId: row.classId,
                    targetName: row.className || row.targetName,
                });
                const subjectTarget = findEntity(project.subjects, {
                    targetId: row.subjectId,
                    targetName: row.subjectName || row.targetName,
                });
                const teacherTarget = findEntity(project.teachers, {
                    targetId: row.teacherId,
                    targetName: row.teacherName || row.targetName,
                });
                const slot = parseFirstSlot(row.slots);
                if (!classTarget || !subjectTarget || !teacherTarget || !slot) {
                    const reason = `${row.targetName || row.rawText || '锁定课节'} 缺少可匹配的班级、课程、教师或节次，请复核。`;
                    warnings.push(reason);
                    return {
                        ...row,
                        status: 'needs_review',
                        targetType: 'locked_slot',
                        warnings: [...row.warnings, reason],
                    };
                }
                const plan = findLockedLessonPlan(project, {
                    classId: classTarget.id,
                    subjectId: subjectTarget.id,
                    teacherId: teacherTarget.id,
                });
                const locked = {
                    id: row.id,
                    day: slot.day,
                    period: slot.period,
                    classId: classTarget.id,
                    subjectId: subjectTarget.id,
                    teacherId: teacherTarget.id,
                    lessonPlanId: plan?.id || null,
                    roomId: plan?.roomId || null,
                };
                addLockedSlot(rules, locked);
                return {
                    ...row,
                    targetType: 'locked_slot',
                    targetId: `${classTarget.id}:${subjectTarget.id}:${teacherTarget.id}`,
                    targetName: `${entityLabel(classTarget)} / ${subjectTarget.name || subjectTarget.id} / ${teacherTarget.name || teacherTarget.id}`,
                    classId: classTarget.id,
                    className: entityLabel(classTarget),
                    subjectId: subjectTarget.id,
                    subjectName: subjectTarget.name || row.subjectName,
                    teacherId: teacherTarget.id,
                    teacherName: teacherTarget.name || row.teacherName,
                    slots: [slotKey(slot.day, slot.period)],
                    priority: 'hard',
                    status: 'effective',
                };
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

            if (row.type === 'teacher_daily_limit' || row.type === 'teacher_consecutive_limit') {
                const limit = Number.parseInt(row.limit ?? row.weight ?? row.value, 10);
                if (isAllTeachersTarget(row)) {
                    if (!Number.isInteger(limit) || limit <= 0 || !(project.teachers || []).length) {
                        const reason = `${row.targetName || '全部教师'} 缺少有效的节数上限或当前项目没有教师，请复核。`;
                        warnings.push(reason);
                        return { ...row, status: 'needs_review', targetType: 'all_teachers', targetId: '__all_teachers', targetName: '全部教师', warnings: [...row.warnings, reason] };
                    }
                    (project.teachers || []).forEach(teacher => {
                        addTeacherLimit(rules, teacher.id, row.type === 'teacher_daily_limit' ? { daily: limit } : { consecutive: limit });
                    });
                    return { ...row, targetType: 'all_teachers', targetId: '__all_teachers', targetName: '全部教师', priority: 'soft', status: 'effective' };
                }
                const teacher = findEntity(project.teachers, row);
                if (!teacher || !Number.isInteger(limit) || limit <= 0) {
                    const reason = `${row.targetName || row.targetId || '教师'} 缺少可匹配教师或有效的节数上限，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'teacher', warnings: [...row.warnings, reason] };
                }
                addTeacherLimit(rules, teacher.id, row.type === 'teacher_daily_limit' ? { daily: limit } : { consecutive: limit });
                return { ...row, targetType: 'teacher', targetId: teacher.id, targetName: teacher.name || row.targetName, priority: 'soft', status: 'effective' };
            }

            if (row.type === 'subject_spread') {
                if (!target) {
                    const reason = `${row.targetName || row.targetId || '课程'} 缺少可匹配课程，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'subject', warnings: [...row.warnings, reason] };
                }
                addSpreadSubject(rules, target.id);
                return { ...row, targetType: 'subject', targetId: target.id, targetName: target.name || row.targetName, priority: 'soft', status: 'effective' };
            }

            return { ...row, status: 'unsupported' };
        });

    const semanticLayer = buildRequirementSemantics(project, rows, {
        originalText,
        semanticRequirements,
    });

    return splitParseResult({
        project,
        draftRules: normalizeTimetableProject({ ...project, rules }).rules,
        rows,
        previewItems: previewRows(rows),
        requirementItems: semanticLayer.requirementItems,
        semanticActions: semanticLayer.semanticActions,
        warnings: [...new Set(warnings.filter(Boolean))],
        source,
        inputType,
        contextStats,
        unsupportedItems,
    });
}

function normalizeAiContent(content) {
    if (typeof content === 'object' && content) return content;
    const text = String(content || '').trim();
    if (!text) return {};
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    return JSON.parse(fenced ? fenced[1] : text);
}

function aiDraftRowsFromParsed(parsed = {}) {
    if (Array.isArray(parsed.draftRows)) return parsed.draftRows;
    const groupedRows = [
        ...(Array.isArray(parsed.autoAcceptable) ? parsed.autoAcceptable : []),
        ...(Array.isArray(parsed.needReview) ? parsed.needReview : []),
        ...(Array.isArray(parsed.unsupportedItems) ? parsed.unsupportedItems : []),
    ];
    if (groupedRows.length) return groupedRows;
    if (Array.isArray(parsed.constraints)) return parsed.constraints;
    if (Array.isArray(parsed.rules)) return parsed.rules;
    return [];
}

function warningMessagesFromAi(value = []) {
    return (Array.isArray(value) ? value : [])
        .map(item => {
            if (typeof item === 'string') return item;
            return item?.message || item?.reason || item?.suggestion || item?.description || '';
        })
        .map(item => asText(item, 240))
        .filter(Boolean);
}

function buildPrompt({ project, text, inputType = 'text', contextStats = null, constraintRows = [] }) {
    return [
        {
            role: 'system',
            content: [
                '你是中文中小学排课约束候选抽取助手。你只负责从自然语言、TXT、XLSX 内容中抽取候选约束，不负责最终生效判断。',
                '只输出 JSON 对象，不要 markdown，不要解释文字。优先输出完整 Agent schema：{"requirementItems":[],"draftRows":[],"autoAcceptable":[],"needReview":[],"clarifyingQuestions":[],"missingInfo":[],"conflicts":[],"warnings":[],"unsupportedItems":[],"confidenceSummary":{"high":0,"medium":0,"low":0},"nextAction":"review"}。',
                'requirementItems 用于表达“对象是谁 + 需求是什么 + 应该落到哪里”；draftRows 用于兼容旧规则草稿。系统会重新校验和重分组。',
                'requirementItems 每条建议包含 object, intent, condition, parameters, strength, status, applyTo, confidence, source, warnings。',
                'object.kind 可用 teacher/class/subject/teacher_group/derived_group/global/lesson_block；applyTo 可用 rule/lesson_plan/solver_policy/optimization/review。',
                '例如“数学必须连堂”输出 requirementItems: object=数学课程, intent=block_preference, parameters.blockPreference=double, applyTo=lesson_plan。',
                '例如“未注明默认单节”“连堂块不能拆开”“教师同时间只能上一个班”属于 handled/system policy，不要生成 teacher_unavailable 全周全节次噪音规则。',
                'draftRows 必须包含所有能映射到旧规则模型的候选约束；autoAcceptable/needReview/unsupportedItems 只是你给出的初步分组，系统会重新校验和重分组。',
                'nextAction 只能是 ask_user、ready_to_apply、review、no_result。遇到歧义或缺失信息时优先 ask_user，不要猜。',
                '系统会在你输出后做确定性实体匹配、歧义检测、冲突预检和最终 normalize；不要把不确定内容强行标记为可生效。',
                '',
                '【可生效约束类型】（会真正影响排课，请尽量归类到这些）：',
                '- teacher_unavailable：某教师在某些时间不能上课。需 targetId/target + slots（或 days+periods）。priority=hard。',
                '- class_unavailable：某班级在某些时间不排课。需 targetId/target + slots。priority=hard。',
                '- locked_slot：把某班某课某师固定在某个具体时间。需 class/subject/teacher + 单个 slot。priority=hard。',
                '- subject_morning：某课程优先排在上午。需 targetId/target（课程）。priority=soft。',
                '- subject_preferred_periods：某课程偏好某些节次。需课程 + slots/periods。priority=soft。',
                '- subject_avoid_periods：某课程避开某些节次。需课程 + slots/periods。priority=soft。',
                '- teacher_daily_limit：某教师每天最多上几节。需教师 + limit（整数）。priority=soft。',
                '- teacher_consecutive_limit：某教师最多连续上几节。需教师 + limit（整数）。priority=soft。',
                '- subject_spread：某课程一周内要分散，不要同一天扎堆。需课程。priority=soft。',
                '',
                '【仅建议类型】（暂不写入排课，仅供复核展示）：teacher_load_balance, block_protection, class_daily_balance, quality_subject_later。无法确定或属于通用常识（如"教师不能同时在两个班"）时，归到这里或写进 warnings，不要编造硬约束。',
                '',
                '【严禁猜测】',
                '- 不允许编造老师、班级、课程、节次；只能使用用户原文或下方项目上下文。',
                '- 如果目标不在 teachers/classes/subjects 中，把原文放在 target/targetName，并降低 confidence。',
                '- 如果存在多个候选，必须在该规则中返回 ambiguity，例如 {"targetText":"王老师","candidates":[{"label":"王明","value":"t1"},{"label":"王华","value":"t2"}]}。',
                '- 低置信度、歧义、缺少目标或缺少节次时，不要强行 effective；confidence 低于 0.65 的内容必须保守。',
                '',
                '【字段规范】：',
                '- slots 用 "day-period" 字符串，day 为周几(1-7)，period 为第几节，例如周三第4节="3-4"。',
                '- 也可用 days:[1,2] + periods:[3,4] 让系统自动展开。',
                '- target 用教师/班级/课程的名称（从下方上下文里匹配），匹配不到就照原文填，targetId 留空。',
                '- 每条规则都必须包含：rawText, type, targetType, targetName, days, periods, priority, reason, confidence, ambiguity。',
                '- locked_slot 必须尽量包含 class/className, subject/subjectName, teacher/teacherName 和单个 slots。',
                '',
                '【强弱判断】',
                '- 用户表达“尽量、最好、优先、希望、建议”时 priority=soft。',
                '- 用户表达“禁止、必须、不能、不要、没空、不可排”时 priority=hard，除非语义明显是偏好。',
                '',
                '【示例】',
                '输入："王老师周三下午都没空" → {"type":"teacher_unavailable","target":"王老师","days":[3],"periods":[5,6,7],"priority":"hard","reason":"王老师周三下午不可排","confidence":0.95}',
                '输入："数学尽量排上午" → {"type":"subject_morning","target":"数学","priority":"soft","reason":"数学优先上午","confidence":0.9}',
                '输入："李老师必须周三第3节上高一1班数学" → {"type":"locked_slot","teacher":"李老师","class":"高一1班","subject":"数学","slots":["3-3"],"priority":"hard","reason":"固定课节","confidence":0.9}',
                '输入："李老师每天最多上3节课" → {"type":"teacher_daily_limit","target":"李老师","limit":3,"priority":"soft","reason":"控制李老师每日工作量","confidence":0.9}',
                '输入："体育不要连着上两节" → {"type":"teacher_consecutive_limit"或"subject_spread","target":"体育","limit":1,"priority":"soft","reason":"体育课分散","confidence":0.8}',
                '输入："美术第一节不要排" → {"type":"subject_avoid_periods","target":"美术","periods":[1],"priority":"soft","reason":"美术避开第一节","confidence":0.85}',
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
        throw new TimetableRuleParseError('智能解析返回内容不是有效 JSON。', 'ai_invalid_json', 502);
    }
    if (!response.ok) {
        throw new TimetableRuleParseError(payload.error?.message || '智能约束解析失败。', 'ai_failed', response.status || 502);
    }

    const content = payload.choices?.[0]?.message?.content ?? payload;
    try {
        return normalizeAiContent(content);
    } catch {
        throw new TimetableRuleParseError('智能解析结果不是有效 JSON。', 'ai_invalid_json', 502);
    }
}

function rowsFromAiConstraints(constraints = [], { inputRows = [], source = 'ai' } = {}) {
    return constraints.map((constraint, index) => {
        const inputRow = inputRows[index] || {};
        const type = normalizeConstraintType(constraint.type || constraint.ruleType);
        return {
            id: asText(constraint.id || inputRow.id, 80) || `rule_draft_${index + 1}`,
            source,
            sourceSheet: constraint.sourceSheet || inputRow.sourceSheet,
            sourceRow: constraint.sourceRow || inputRow.sourceRow,
            rawText: constraint.rawText || constraint.constraintText || inputRow.constraintText || constraint.reason || constraint.description || '',
            type,
            targetType: constraint.targetType || targetTypeFor(type, constraint),
            targetId: constraint.targetId || constraint.teacherId || constraint.classId || constraint.subjectId || '',
            targetName: constraint.targetName || constraint.target || constraint.teacher || constraint.class || constraint.subject || '',
            classId: constraint.classId || '',
            className: constraint.className || constraint.class || '',
            subjectId: constraint.subjectId || '',
            subjectName: constraint.subjectName || constraint.subject || '',
            teacherId: constraint.teacherId || '',
            teacherName: constraint.teacherName || constraint.teacher || '',
            slots: constraint.slots || constraint.slotKeys || [],
            days: constraint.days || constraint.weekdays || '',
            periods: constraint.periods || constraint.lessonIndexes || '',
            priority: constraint.priority || constraint.strength,
            status: SUPPORTED_EFFECTIVE_TYPES.has(type) ? 'effective' : SUGGESTION_ONLY_TYPES.has(type) ? 'suggestion' : 'unsupported',
            confidence: constraint.confidence ?? null,
            ambiguity: constraint.ambiguity || null,
            ambiguities: constraint.ambiguities || [],
            description: constraint.reason || constraint.description || constraint.note || '',
            warnings: Array.isArray(constraint.warnings) ? constraint.warnings : [],
            weekPattern: constraint.weekPattern || '',
            weight: constraint.weight,
            limit: constraint.limit ?? constraint.value ?? constraint.max ?? constraint.maxPerDay ?? constraint.maxConsecutive,
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
    const laterPeriods = [...new Set([
        ...getDayPartPeriods(project, 'afternoon'),
        ...getDayPartPeriods(project, 'evening'),
    ])];
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
        .split(/[\n。；;!?！？]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function splitClauses(sentence = '') {
    return String(sentence)
        .split(/[，,]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function parseTimeSpec(sentence, project) {
    const days = parseDays(sentence, project, []);
    const periods = parsePeriods(sentence, project, []);
    const weekPattern = weekPatternFromText(sentence);
    if (!periods.length) return [];
    const targetDays = days.length ? days : getActiveWeekdays(project);
    const slots = targetDays.flatMap(day => periods.map(period => slotKey(day, period)));
    return {
        days,
        periods,
        slots,
        weekPattern,
    };
}

function textSlots(sentence, project) {
    return parseTimeSpec(sentence, project).slots || [];
}

function uniqueTargets(targets = []) {
    const seen = new Set();
    return targets.filter(target => {
        const key = normalizeEntityName(target.name || target.id || '');
        if (!target.name && !target.id) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function textTeacherTargets(sentence = '', project = {}) {
    const targets = [];
    project.teachers.forEach(teacher => {
        if (teacher.name && sentence.includes(teacher.name)) targets.push({ id: teacher.id, name: teacher.name });
    });
    for (const match of sentence.matchAll(/([A-Za-z][A-Za-z ]{1,40}Teacher|[\u4e00-\u9fa5]{1,4}(?:老师|教师))/g)) {
        targets.push({ id: '', name: match[1] });
    }
    return uniqueTargets(targets);
}

function textClassTargets(sentence = '', project = {}) {
    const targets = [];
    project.classes.forEach(klass => {
        const label = entityLabel(klass);
        if ((label && sentence.includes(label)) || (klass.name && sentence.includes(klass.name))) {
            targets.push({ id: klass.id, name: label || klass.name });
        }
    });
    for (const match of sentence.matchAll(/((?:高|初|七|八|九|一|二|三)[一二三四五六七八九十0-9]*年?级?\s*\d{0,2}\s*班|高[一二三]\s*\d{1,2}\s*班|初[一二三]\s*\d{1,2}\s*班)/g)) {
        targets.push({ id: '', name: match[1].replace(/\s+/g, '') });
    }
    return uniqueTargets(targets);
}

function textSubjectTargets(sentence = '', project = {}) {
    const targets = [];
    project.subjects.forEach(subject => {
        if (subject.name && sentence.includes(subject.name)) targets.push({ id: subject.id, name: subject.name });
    });
    if (!targets.length && /(尽量|优先|最好|希望|prefer|避开|不要|不排)/i.test(sentence)) {
        const match = sentence.match(/^(.{1,12}?)(?:尽量|优先|最好|希望|要|排|安排|避开|不要|不排)/);
        if (match) {
            const name = match[1].replace(/^\d+\.\s*/, '').replace(/课程|学科|科目/g, '').trim();
            if (name) targets.push({ id: '', name });
        }
    }
    return uniqueTargets(targets);
}

function hasMainSubjectShorthand(sentence = '') {
    return /语数英|语文.*数学.*英语|数学.*语文.*英语|main subjects/i.test(sentence);
}

function mainSubjectTargets(project = {}) {
    return project.subjects
        .filter(subject => /(语文|数学|英语|chinese|math|english)/i.test(subject.name))
        .map(subject => ({ id: subject.id, name: subject.name }));
}

function isContinuationClause(sentence = '') {
    return /^(尤其|其中|同时|并且|而且|另外|优先|最好|特别|更|再|还|也)/.test(sentence.trim());
}

function withSource(item = {}, sourceMeta = {}) {
    return {
        ...item,
        sourceSheet: sourceMeta.sourceSheet || item.sourceSheet,
        sourceRow: sourceMeta.sourceRow || item.sourceRow,
    };
}

function slotSetIsSubset(left = [], right = []) {
    if (!left.length || !right.length || left.length >= right.length) return false;
    const rightSet = new Set(right);
    return left.every(slot => rightSet.has(slot));
}

function compactLocalConstraints(constraints = []) {
    const kept = [];
    for (const item of constraints) {
        if (item.type === 'subject_preferred_periods' && (item.slots || []).length) {
            const keyFor = value => JSON.stringify([
                value.type,
                value.targetId || '',
                value.target || '',
                value.sourceSheet || '',
                value.sourceRow || '',
                value.weekPattern || '',
            ]);
            const key = keyFor(item);
            const existingIndex = kept.findIndex(value => keyFor(value) === key);
            if (existingIndex >= 0) {
                const existing = kept[existingIndex];
                if (slotSetIsSubset(item.slots || [], existing.slots || [])) {
                    kept[existingIndex] = item;
                    continue;
                }
                if (slotSetIsSubset(existing.slots || [], item.slots || [])) continue;
            }
        }
        kept.push(item);
    }
    const seen = new Set();
    return kept.filter(item => {
        const key = JSON.stringify([item.type, item.targetId, item.target, item.slots || [], item.limit ?? null, item.sourceSheet || '', item.sourceRow || '', item.weekPattern || '']);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function localTextConstraints(project, text, sourceMeta = {}) {
    const constraints = [];
    const sentences = splitSentences(text);
    const unavailablePattern = /(不要排|不排|不可排|不能排|没空|不可用|unavailable|avoid)/i;
    const preferPattern = /(优先|尽量|prefer|preferred|安排到)/i;
    const avoidPattern = /(避开|不要|不排|avoid)/i;

    for (const sentenceGroup of sentences) {
        const context = {
            teacherTargets: [],
            classTargets: [],
            subjectTargets: [],
            prefer: false,
            avoid: false,
            unavailable: false,
            rawText: '',
        };

        for (const sentence of splitClauses(sentenceGroup)) {
            const timeSpec = parseTimeSpec(sentence, project);
            const slots = timeSpec.slots || [];
            const continuation = isContinuationClause(sentence);
            const teacherTargets = textTeacherTargets(sentence, project);
            const classTargets = textClassTargets(sentence, project);
            let subjectTargets = continuation ? [] : textSubjectTargets(sentence, project);
            if (hasMainSubjectShorthand(sentence)) subjectTargets = mainSubjectTargets(project);
            const effectiveTeacherTargets = teacherTargets.length ? teacherTargets : continuation ? context.teacherTargets : [];
            const effectiveClassTargets = classTargets.length ? classTargets : continuation ? context.classTargets : [];
            const effectiveSubjectTargets = subjectTargets.length ? subjectTargets : continuation ? context.subjectTargets : [];
            const hasPrefer = preferPattern.test(sentence) || (continuation && context.prefer);
            const hasAvoid = avoidPattern.test(sentence) || (continuation && context.avoid);
            const hasUnavailable = unavailablePattern.test(sentence) || (continuation && context.unavailable);
            const rawText = continuation && context.rawText ? `${context.rawText}，${sentence}` : sentence;
            const weekPattern = timeSpec.weekPattern || weekPatternFromText(sentence) || (continuation ? context.weekPattern : '');
            const broadDayPartOnly = Boolean(dayPartName(sentence)) && !hasExplicitPeriodExpression(sentence);

            if (/(必须|固定|锁定|指定)/.test(sentence) && slots.length && effectiveTeacherTargets.length && effectiveClassTargets.length && effectiveSubjectTargets.length) {
                const teacher = effectiveTeacherTargets[0];
                const klass = effectiveClassTargets[0];
                const subject = effectiveSubjectTargets[0];
                constraints.push(withSource({
                type: 'locked_slot',
                teacherId: teacher.id,
                teacher: teacher.name,
                classId: klass.id,
                class: klass.name,
                subjectId: subject.id,
                subject: subject.name,
                slots: [slots[0]],
                priority: 'hard',
                reason: rawText,
                confidence: 0.88,
                weekPattern,
                }, sourceMeta));
                continue;
            }

            effectiveTeacherTargets.forEach(teacher => {
                if (hasUnavailable && slots.length) {
                    constraints.push(withSource({
                    type: 'teacher_unavailable',
                    targetId: teacher.id,
                    target: teacher.name,
                    slots,
                    priority: 'hard',
                    reason: rawText,
                    confidence: teacher.id ? 0.88 : 0.74,
                    weekPattern,
                    }, sourceMeta));
                }
                const dailyMatch = sentence.match(new RegExp(`每[天日].*?(?:最多|不超过|不多于|上限)\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`));
                if (dailyMatch) {
                    constraints.push(withSource({
                    type: 'teacher_daily_limit',
                    targetId: teacher.id,
                    target: teacher.name,
                    limit: parseLooseNumber(dailyMatch[1]),
                    priority: 'soft',
                    reason: rawText,
                    confidence: teacher.id ? 0.82 : 0.7,
                    weekPattern,
                    }, sourceMeta));
                }
                const consecutiveMatch = sentence.match(new RegExp(`(?:连续|连排|连堂).*?(?:最多|不超过|不多于)\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`));
                if (consecutiveMatch) {
                    constraints.push(withSource({
                    type: 'teacher_consecutive_limit',
                    targetId: teacher.id,
                    target: teacher.name,
                    limit: parseLooseNumber(consecutiveMatch[1]),
                    priority: 'soft',
                    reason: rawText,
                    confidence: teacher.id ? 0.8 : 0.68,
                    weekPattern,
                    }, sourceMeta));
                }
            });
            effectiveClassTargets.forEach(klass => {
                if (hasUnavailable && slots.length) {
                    constraints.push(withSource({
                    type: 'class_unavailable',
                    targetId: klass.id,
                    target: klass.name,
                    slots,
                    priority: 'hard',
                    reason: rawText,
                    confidence: klass.id ? 0.84 : 0.68,
                    weekPattern,
                    }, sourceMeta));
                }
            });
            effectiveSubjectTargets.forEach(subject => {
                const teacherUnavailableSentence = project.teachers.some(teacher => sentence.includes(teacher.name))
                    && hasUnavailable
                    && !hasPrefer;
                if (teacherUnavailableSentence) return;
                if (slots.length && hasPrefer && !broadDayPartOnly) {
                    constraints.push(withSource({
                    type: 'subject_preferred_periods',
                    targetId: subject.id,
                    target: subject.name,
                    slots,
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.9 : 0.64,
                    weekPattern,
                    }, sourceMeta));
                } else if (slots.length && hasAvoid) {
                    constraints.push(withSource({
                    type: 'subject_avoid_periods',
                    targetId: subject.id,
                    target: subject.name,
                    slots,
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.9 : 0.64,
                    weekPattern,
                    }, sourceMeta));
                } else if (/上午|早上/.test(sentence) && hasPrefer) {
                    constraints.push(withSource({
                    type: 'subject_morning',
                    targetId: subject.id,
                    target: subject.name,
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.86 : 0.68,
                    weekPattern,
                    }, sourceMeta));
                }
            });

            if (teacherTargets.length) context.teacherTargets = teacherTargets;
            if (classTargets.length) context.classTargets = classTargets;
            if (subjectTargets.length) context.subjectTargets = subjectTargets;
            if (hasPrefer) context.prefer = true;
            if (hasAvoid) context.avoid = true;
            if (hasUnavailable) context.unavailable = true;
            if (weekPattern) context.weekPattern = weekPattern;
            if (teacherTargets.length || classTargets.length || subjectTargets.length || slots.length || hasPrefer || hasAvoid || hasUnavailable) {
                context.rawText = rawText;
            }
        }
    }

    return compactLocalConstraints(constraints);
}

function localTextConstraintsFromInput(project, text, constraintRows = []) {
    if (Array.isArray(constraintRows) && constraintRows.length) {
        return constraintRows.flatMap(row => {
            const rowText = asText(row.constraintText || row.rawText || row.description || '', 1500);
            if (!rowText) return [];
            return localTextConstraints(project, rowText, {
                sourceSheet: row.sourceSheet,
                sourceRow: row.sourceRow,
            });
        });
    }
    return localTextConstraints(project, text);
}

function parseConstraintsWithLocalFallback({ project, text, inputType, contextStats = null, constraintRows = [], error = null }) {
    const constraints = localTextConstraintsFromInput(project, text, constraintRows);
    if (!constraints.length) {
        const semanticOnly = normalizeTimetableRuleDraftRows({
            project,
            draftRows: [],
            source: 'local_text',
            inputType,
            contextStats,
            originalText: text,
            initialWarnings: error ? [`智能解析不可用，已仅提取明确需求：${error.reason || error.message}`] : [],
        });
        if ((semanticOnly.requirementItems || []).length) return semanticOnly;
        if (error) throw error;
        throw new TimetableRuleParseError('需要配置智能解析服务才能解析这类约束。', 'ai_not_configured', 503);
    }
    return normalizeTimetableRuleDraftRows({
        project,
        draftRows: rowsFromAiConstraints(constraints, { inputRows: constraintRows, source: 'local_text' }),
        source: 'local_text',
        inputType,
        contextStats,
        originalText: text,
        initialWarnings: error ? [`智能解析不可用，已仅提取明确规则：${error.reason || error.message}`] : [],
    });
}

function hasConfiguredAi(env = {}) {
    return Boolean(String(env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || '').trim());
}

function shouldUseLocalFirst(inputType = '') {
    return ['text', 'txt', 'csv_text'].includes(inputType);
}

function localResultIsDecisive(result = {}) {
    const rows = result.draftRows || [];
    if (!rows.length) return false;
    return rows.some(row => row.status === 'effective' || row.weekPattern);
}

function localResultCanSkipAi(text = '', result = {}) {
    if (/[A-Za-z]/.test(text)) return false;
    return localResultIsDecisive(result);
}

async function parseAiOrLocal({ project, text, inputType, contextStats = null, constraintRows = [], env, fetchImpl }) {
    if (shouldUseLocalFirst(inputType)) {
        const localConstraints = localTextConstraintsFromInput(project, text, constraintRows);
        if (localConstraints.length) {
            const localResult = normalizeTimetableRuleDraftRows({
                project,
                draftRows: rowsFromAiConstraints(localConstraints, { inputRows: constraintRows, source: 'local_text' }),
                source: 'local_text',
                inputType,
                contextStats,
                originalText: text,
                initialWarnings: hasConfiguredAi(env) ? [] : ['智能解析不可用，已仅提取明确规则：ai_not_configured'],
            });
            if (!hasConfiguredAi(env) || localResultCanSkipAi(text, localResult)) return localResult;
        } else if (!hasConfiguredAi(env)) {
            const semanticOnly = normalizeTimetableRuleDraftRows({
                project,
                draftRows: [],
                source: 'local_text',
                inputType,
                contextStats,
                originalText: text,
                initialWarnings: ['智能解析不可用，已仅提取明确需求：ai_not_configured'],
            });
            if ((semanticOnly.requirementItems || []).length) return semanticOnly;
        }
    }
    try {
        const parsed = await callAi({ project, text, inputType, contextStats, constraintRows, env, fetchImpl });
        const constraints = aiDraftRowsFromParsed(parsed);
        const warnings = [
            ...warningMessagesFromAi(parsed.warnings),
            ...warningMessagesFromAi(parsed.missingInfo),
            ...warningMessagesFromAi(parsed.conflicts),
        ];
        return normalizeTimetableRuleDraftRows({
            project,
            draftRows: rowsFromAiConstraints(constraints, { inputRows: constraintRows, source: 'ai' }),
            source: 'ai',
            inputType,
            contextStats,
            originalText: text,
            semanticRequirements: parsed.requirementItems || [],
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
                '智能解析没有返回可复核的约束，已根据任课表生成本地基础建议。',
            ],
        });
    } catch (error) {
        return normalizeRosterFallback({
            project: rosterProject,
            preview,
            contextStats,
            initialWarnings: [`智能解析不可用，已根据任课表生成本地基础建议：${error.reason || error.message}`],
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
        throw new TimetableRuleParseError('智能约束文件只支持 .txt、.csv、.xlsx、.xls。', 'unsupported_file_type', 400);
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
