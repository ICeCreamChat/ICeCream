import { createHash } from 'node:crypto';
import path from 'node:path';

import AdmZip from 'adm-zip';

import {
    cleanText,
    getActivePeriods,
    getDayPartPeriods,
    getActiveWeekdays,
    makeTimetableId,
    normalizeTimetableProject,
    normalizeWeekPattern,
    slotKey,
} from './timetable-project.js';
import {
    buildTimetableRosterFromRows,
    previewTimetableRosterFile,
} from './timetable-import.js';
import {
    compileRequirementToRows,
} from './timetable-intent-compiler.js';
import {
    AI_REQUIREMENT_PROMPT_VERSION,
} from './timetable-ai-prompts.js';
import {
    extractRequirementsWithAI,
} from './timetable-ai-extractor.js';
import {
    applyClarificationPolicy,
} from './timetable-clarify-policies.js';

const MAX_RULE_FILE_BYTES = 5 * 1024 * 1024;
const PARSER_VERSION = 'timetable_rule_parser_xlsx_stable_v1';
const AI_REVIEW_PROMPT_VERSION = 'timetable_ai_review_v1';
const DEFAULT_AI_REVIEW_TIMEOUT_MS = 30_000;
const PARSE_CACHE = new Map();
const MAX_PARSE_CACHE_ITEMS = 40;

const SUPPORTED_EFFECTIVE_TYPES = new Set([
    'teacher_unavailable',
    'class_unavailable',
    'locked_slot',
    'global_unavailable',
    'subject_morning',
    'subject_afternoon',
    'subject_preferred_periods',
    'subject_avoid_periods',
    'subject_daily_limit',
    'teacher_daily_limit',
    'teacher_consecutive_limit',
    'teacher_weekly_limit',
    'teacher_max_days_per_week',
    'teacher_mutual_exclusion',
    'subject_spread',
    'course_interval',
    'room_requirement',
    'class_daily_balance',
    'teacher_gap_preference',
    'teacher_load_balance',
    'subject_not_same_day',
    'subject_sequence',
]);

const SUGGESTION_ONLY_TYPES = new Set([
    'quality_subject_later',
    'block_protection',
    'class_subject_spread',
]);

const STATUS_LABELS = new Set(['effective', 'ready', 'needs_review', 'suggestion', 'unsupported', 'invalid', 'ignored']);
const SYSTEM_TEACHER_TIME_CONFLICT_PATTERN = /同一.*教师.*同一.*时间.*(只能|一个班|一门课)|教师.*不能.*同.*时间.*(多个|两个|两个班|上课)/;
const SYSTEM_CLASS_TIME_CONFLICT_PATTERN = /同一.*班级.*同一.*时间.*(只能|一门|一节)|班级.*不能.*同.*时间.*(多个|两门|两节)/;
const SYSTEM_LESSON_HOURS_COMPLETENESS_PATTERN = /(每个|各个)?.*班级.*(每门|各门)?.*课程.*(周课时|课时).*(排满|不能少排|不能多排|不少排|不多排)|周课时.*(排满|不能少排|不能多排)/;
const DAY_NAME_TO_NUMBER = new Map([
    ['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['日', 7], ['天', 7],
    ['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7],
]);
const ENGLISH_DAY_NAME_TO_NUMBER = new Map([
    ['monday', 1], ['mon', 1],
    ['tuesday', 2], ['tue', 2], ['tues', 2],
    ['wednesday', 3], ['wed', 3],
    ['thursday', 4], ['thu', 4], ['thur', 4], ['thurs', 4],
    ['friday', 5], ['fri', 5],
    ['saturday', 6], ['sat', 6],
    ['sunday', 7], ['sun', 7],
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

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

function hashValue(value, length = 16) {
    return createHash('sha256')
        .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stableJson(value))
        .digest('hex')
        .slice(0, length);
}

function projectFingerprintForParse(project = {}) {
    return {
        id: project.id || '',
        schoolName: project.schoolName || '',
        term: project.term || '',
        activeWeekdays: project.activeWeekdays || [],
        activePeriods: project.activePeriods || [],
        dayPartBoundaries: project.dayPartBoundaries || {},
        periodTimes: project.periodTimes || {},
        periodTimeSegments: project.periodTimeSegments || null,
        teachers: project.teachers || [],
        classes: project.classes || [],
        subjects: project.subjects || [],
        lessonPlans: project.lessonPlans || [],
        rules: project.rules || {},
    };
}

function aiReviewDisabled(env = {}) {
    return ['1', 'true', 'yes', 'on'].includes(String(env.TIMETABLE_RULE_AI_REVIEW_DISABLED || '').trim().toLowerCase());
}

function aiReviewTimeoutMs(env = {}) {
    const value = Number.parseInt(env.TIMETABLE_RULE_AI_REVIEW_TIMEOUT_MS, 10);
    if (Number.isInteger(value) && value > 0) return Math.min(value, 120_000);
    return DEFAULT_AI_REVIEW_TIMEOUT_MS;
}

function aiReviewCachePart(env = {}) {
    const aiExtractEnabled = ['1', 'true', 'yes', 'on'].includes(String(env.TIMETABLE_RULE_AI_EXTRACT || '').trim().toLowerCase());
    const extractPart = aiExtractEnabled ? `:ai_extract:${AI_REQUIREMENT_PROMPT_VERSION}` : '';
    if (aiReviewDisabled(env)) return `ai_review_disabled${extractPart}`;
    if (!hasConfiguredAi(env)) return 'ai_review_unavailable';
    try {
        const { model } = resolveAiConfig(env);
        return `ai_review:${AI_REVIEW_PROMPT_VERSION}${extractPart}:${model || 'unknown'}`;
    } catch {
        return `ai_review:${AI_REVIEW_PROMPT_VERSION}${extractPart}:unresolved`;
    }
}

function parseCacheKey({ fileBuffer, project, env = {} }) {
    return [
        PARSER_VERSION,
        aiReviewCachePart(env),
        hashValue(fileBuffer, 32),
        hashValue(projectFingerprintForParse(project), 24),
    ].join(':');
}

function getParseCache(key = '') {
    if (!key || !PARSE_CACHE.has(key)) return null;
    const cached = PARSE_CACHE.get(key);
    PARSE_CACHE.delete(key);
    PARSE_CACHE.set(key, cached);
    return cloneValue(cached);
}

function setParseCache(key = '', value = null) {
    if (!key || !value) return;
    while (PARSE_CACHE.size >= MAX_PARSE_CACHE_ITEMS) {
        const oldestKey = PARSE_CACHE.keys().next().value;
        if (!oldestKey) break;
        PARSE_CACHE.delete(oldestKey);
    }
    PARSE_CACHE.set(key, cloneValue(value));
}

function withParseMetadata(result = {}, overrides = {}) {
    return {
        ...result,
        parserVersion: result.parserVersion || PARSER_VERSION,
        parseSource: overrides.parseSource || result.parseSource || result.source || '',
        cacheHit: Boolean(overrides.cacheHit ?? result.cacheHit),
    };
}

function aiReviewStatusPayload({
    status = 'unavailable',
    reason = '',
    model = '',
    reviewItems = [],
    warnings = [],
    appliedSuggestionCount = 0,
    flaggedCount = 0,
} = {}) {
    return {
        status,
        reason: asText(reason, 120),
        model: asText(model, 120),
        reviewedAt: new Date().toISOString(),
        warningCount: warnings.length,
        flaggedCount,
        appliedSuggestionCount,
        reviewItems,
    };
}

function withAiReviewUnavailable(result = {}, reason = 'ai_not_configured', message = 'AI 复审不可用，已返回本地识别结果。') {
    const warning = asText(message, 240);
    return {
        ...result,
        warnings: [...new Set([...(result.warnings || []), warning].filter(Boolean))],
        aiReview: aiReviewStatusPayload({
            status: reason === 'disabled' ? 'skipped' : 'unavailable',
            reason,
            warnings: warning ? [warning] : [],
        }),
    };
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

function textFromConstraintRows(rows = []) {
    return (Array.isArray(rows) ? rows : [])
        .map((item, index) => {
            const direct = asText(item.constraintText || item.rawText, 1500);
            const text = direct || [
                item.ruleName ? `名称：${item.ruleName}` : '',
                item.ruleType ? `类型：${item.ruleType}` : '',
                item.target ? `对象：${item.target}` : '',
                item.days ? `周几：${item.days}` : '',
                item.periods ? `节次：${item.periods}` : '',
                item.slots ? `时间：${item.slots}` : '',
                item.priority ? `强度：${item.priority}` : '',
                item.description ? `说明：${item.description}` : '',
            ].filter(Boolean).join('；');
            return text ? `${index + 1}. ${text}` : '';
        })
        .filter(Boolean)
        .join('\n');
}

function normalizeConstraintType(value) {
    const text = String(value || '').trim().toLowerCase().replace(/-/g, '_');
    const compact = text.replace(/\s+/g, '');
    if (['teacherunavailable', '教师不可排', '教师不排', '教师时间不可用', 'teacher_not_available'].includes(compact)) return 'teacher_unavailable';
    if (['classunavailable', '班级不可排', '班级不排', 'class_not_available'].includes(compact)) return 'class_unavailable';
    if (['globalunavailable', '全校不可排', '公共不可排', '全局不可排', 'school_unavailable'].includes(compact)) return 'global_unavailable';
    if (['subjectmorning', '课程上午优先', '主科上午', '上午优先', 'morning_subject', 'subject_prefer_morning'].includes(compact)) return 'subject_morning';
    if (['subjectafternoon', '课程下午优先', '下午优先', 'afternoon_subject', 'subject_prefer_afternoon'].includes(compact)) return 'subject_afternoon';
    if (['subjectpreferperiods', 'subjectpreferredperiods', '课程偏好节次', '课程优先节次', 'subject_prefer_periods', 'subject_preferred_slots'].includes(compact)) return 'subject_preferred_periods';
    if (['subjectavoidperiods', '课程避开节次', 'subject_avoid_slots'].includes(compact)) return 'subject_avoid_periods';
    if (/课程.*每[天日].*(最多|上限|不超过)|subject.*dail?y?.*(limit|max)/.test(text)) return 'subject_daily_limit';
    if (/教师.*每[天日].*(最多|上限|不超过)|teacher.*dail?y?.*(limit|max)/.test(text)) return 'teacher_daily_limit';
    if (/教师.*(连续|连堂|连排).*(最多|上限|不超过|限制)|teacher.*consecutive/.test(text)) return 'teacher_consecutive_limit';
    if (/教师.*每周.*(最多|上限|不超过)|teacher.*week.*(limit|max)/.test(text)) return 'teacher_weekly_limit';
    if (/教师.*(每周)?(最多|上限|不超过).*([天日])|teacher.*max.*days/.test(text)) return 'teacher_max_days_per_week';
    if (/教师.*(互斥|不能同时|错开)|mutual.*exclusion/.test(text)) return 'teacher_mutual_exclusion';
    if (/(同科|同一?门?课|同学科).*(分散|不要?连?排?在?同一?天|错开)|subject.*spread/.test(text)) return 'subject_spread';
    if (/课程.*间隔|course.*interval/.test(text)) return 'course_interval';
    if (/教室|场地|实验室|机房|room/.test(text)) return 'room_requirement';
    if (/班级.*(每天|每日).*(均衡|平衡)|class.*daily.*balance/.test(text)) return 'class_daily_balance';
    if (/教师.*空堂|少空堂|teacher.*gap/.test(text)) return 'teacher_gap_preference';
    if (/教师.*(均衡|负载)|teacher.*load/.test(text)) return 'teacher_load_balance';
    if (/课程.*(不同天|不要同天|不能同天)|subject.*not.*same.*day/.test(text)) return 'subject_not_same_day';
    if (/课程.*顺序|先.*后|subject.*sequence/.test(text)) return 'subject_sequence';
    if (/连堂.*(保护|不可拆)|block/.test(text)) return 'block_protection';
    return text;
}

function normalizePriority(value, type) {
    const text = String(value || '').toLowerCase();
    if (/软|soft|建议/.test(text)) return 'soft';
    if (/硬|hard|必须|不可|不能/.test(text)) return 'hard';
    return String(type || '').startsWith('subject_')
        || ['class_daily_balance', 'teacher_gap_preference', 'teacher_load_balance', 'course_interval'].includes(type)
        || SUGGESTION_ONLY_TYPES.has(type)
        ? 'soft'
        : 'hard';
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
    for (const match of text.matchAll(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)\b/gi)) {
        const number = ENGLISH_DAY_NAME_TO_NUMBER.get(match[1].toLowerCase());
        if (number) values.push(number);
    }
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
    for (const match of text.matchAll(/\bperiod\s*(\d{1,2})\b/gi)) {
        values.push(Number.parseInt(match[1], 10));
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

function systemHandledIntentFromText(text = '') {
    const sourceText = asText(text, 1600);
    if (SYSTEM_TEACHER_TIME_CONFLICT_PATTERN.test(sourceText)) return 'teacher_time_conflict';
    if (SYSTEM_CLASS_TIME_CONFLICT_PATTERN.test(sourceText)) return 'class_time_conflict';
    if (SYSTEM_LESSON_HOURS_COMPLETENESS_PATTERN.test(sourceText)) return 'lesson_hours_completeness';
    return '';
}

function isSystemHandledDraftRow(row = {}) {
    const text = [row.rawText, row.description, row.reason, row.constraintText, row.ruleName]
        .map(value => asText(value, 1200))
        .filter(Boolean)
        .join('。');
    if (!systemHandledIntentFromText(text)) return false;
    return ['teacher_unavailable', 'class_unavailable', 'unsupported'].includes(normalizeConstraintType(row.type || row.ruleType));
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
    if (type === 'teacher_daily_limit' || type === 'teacher_consecutive_limit' || type === 'teacher_weekly_limit' || type === 'teacher_max_days_per_week') return 'teacher';
    if (type === 'class_unavailable') return 'class';
    if (type === 'locked_slot') return 'locked_slot';
    if (type === 'global_unavailable' || type === 'class_daily_balance' || type === 'teacher_gap_preference' || type === 'teacher_load_balance' || type === 'teacher_mutual_exclusion' || type === 'subject_not_same_day' || type === 'subject_sequence') return 'global';
    if (type === 'room_requirement' || type === 'course_interval') return 'subject';
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

function resolveEntityList(items = [], values = []) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : [values]) {
        const text = asText(value, 160);
        if (!text) continue;
        const match = findEntity(items, { targetId: text, targetName: text });
        if (match && !seen.has(match.id)) {
            seen.add(match.id);
            result.push(match);
        }
    }
    return result;
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

function addAfternoonSubject(rules, subjectId) {
    if (!subjectId) return;
    const current = rules.softRules.afternoonSubjects || [];
    if (!current.includes(subjectId)) current.push(subjectId);
    rules.softRules.afternoonSubjects = current;
}

function addSubjectPeriodPreference(rules, subjectId, { prefer = [], avoid = [], weight = 20, weekPattern = '' } = {}) {
    if (!subjectId) return;
    rules.softRules.subjectPreferredPeriods = { ...(rules.softRules.subjectPreferredPeriods || {}) };
    const current = rules.softRules.subjectPreferredPeriods[subjectId] || { prefer: [], avoid: [], weight };
    rules.softRules.subjectPreferredPeriods[subjectId] = {
        prefer: [...new Set([...(current.prefer || []), ...prefer])].sort(),
        avoid: [...new Set([...(current.avoid || []), ...avoid])].sort(),
        weight: Math.max(1, Math.min(100, Number.parseInt(weight ?? current.weight ?? 20, 10) || 20)),
        ...(weekPattern ? { weekPattern: normalizeWeekPattern(weekPattern) } : current.weekPattern ? { weekPattern: current.weekPattern } : {}),
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

function addCourseInterval(rules, subjectId, minGapDays = 1) {
    addSpreadSubject(rules, subjectId);
    rules.softRules.spreadSubjectGaps = { ...(rules.softRules.spreadSubjectGaps || {}) };
    const gap = Math.max(1, Math.min(7, Number.parseInt(minGapDays, 10) || 1));
    const current = Number.parseInt(rules.softRules.spreadSubjectGaps[subjectId], 10);
    rules.softRules.spreadSubjectGaps[subjectId] = Number.isInteger(current) ? Math.max(current, gap) : gap;
}

function addGlobalUnavailable(rules, slots = []) {
    rules.hardRules.globalUnavailable = [...new Set([...(rules.hardRules.globalUnavailable || []), ...slots])].sort();
}

function setIntLimit(map, id, limit, min = 1, max = 40, preferLower = true) {
    const value = Number.parseInt(limit, 10);
    if (!id || !Number.isInteger(value) || value <= 0) return;
    const clamped = Math.max(min, Math.min(max, value));
    const current = Number.parseInt(map[id], 10);
    if (Number.isInteger(current)) {
        map[id] = preferLower ? Math.min(current, clamped) : Math.max(current, clamped);
    } else {
        map[id] = clamped;
    }
}

function addSubjectDailyLimit(rules, subjectId, limit) {
    rules.hardRules.subjectDailyLimit = { ...(rules.hardRules.subjectDailyLimit || {}) };
    setIntLimit(rules.hardRules.subjectDailyLimit, subjectId, limit, 1, 8, true);
}

function addTeacherWeeklyLimit(rules, teacherId, limit) {
    rules.hardRules.teacherWeeklyLimit = { ...(rules.hardRules.teacherWeeklyLimit || {}) };
    setIntLimit(rules.hardRules.teacherWeeklyLimit, teacherId, limit, 1, 40, true);
}

function addTeacherMaxDaysPerWeek(rules, teacherId, limit) {
    rules.hardRules.teacherMaxDaysPerWeek = { ...(rules.hardRules.teacherMaxDaysPerWeek || {}) };
    setIntLimit(rules.hardRules.teacherMaxDaysPerWeek, teacherId, limit, 1, 7, true);
}

function addTeacherMutualExclusion(rules, teacherIds = []) {
    const ids = [...new Set(teacherIds.map(id => asText(id, 120)).filter(Boolean))].sort();
    if (ids.length < 2) return;
    const key = ids.join('|');
    const current = rules.hardRules.teacherMutualExclusion || [];
    if (!current.some(group => [...(group.teacherIds || [])].sort().join('|') === key)) {
        current.push({ teacherIds: ids });
    }
    rules.hardRules.teacherMutualExclusion = current;
}

function addSubjectNotSameDay(rules, subjectIds = [], classIds = []) {
    const subjects = [...new Set(subjectIds.map(id => asText(id, 120)).filter(Boolean))].slice(0, 2);
    if (subjects.length < 2) return;
    const classes = [...new Set(classIds.map(id => asText(id, 120)).filter(Boolean))].sort();
    const key = `${subjects.slice().sort().join('|')}::${classes.join('|')}`;
    const current = rules.hardRules.subjectNotSameDay || [];
    if (!current.some(item => `${[...(item.subjectIds || [])].sort().join('|')}::${[...(item.classIds || [])].sort().join('|')}` === key)) {
        current.push({ subjectIds: subjects, classIds: classes });
    }
    rules.hardRules.subjectNotSameDay = current;
}

function addRoomRequirement(rules, subjectId, { roomIds = [], requiredTags = [] } = {}) {
    if (!subjectId) return;
    const rooms = [...new Set(roomIds.map(id => asText(id, 120)).filter(Boolean))];
    const tags = [...new Set(requiredTags.map(id => asText(id, 120)).filter(Boolean))];
    if (!rooms.length && !tags.length) return;
    rules.hardRules.roomRequirements = { ...(rules.hardRules.roomRequirements || {}) };
    const current = rules.hardRules.roomRequirements[subjectId] || { roomIds: [], requiredTags: [] };
    rules.hardRules.roomRequirements[subjectId] = {
        roomIds: [...new Set([...(current.roomIds || []), ...rooms])],
        requiredTags: [...new Set([...(current.requiredTags || []), ...tags])],
    };
}

function setClassDailyBalance(rules, { mainSubjectDailyMax = 0 } = {}) {
    const current = rules.softRules.classDailyBalance || {};
    rules.softRules.classDailyBalance = {
        enabled: true,
        mainSubjectDailyMax: Math.max(
            Number.parseInt(current.mainSubjectDailyMax, 10) || 0,
            Math.max(0, Math.min(8, Number.parseInt(mainSubjectDailyMax, 10) || 0)),
        ),
    };
}

function setTeacherLoadBalance(rules, weight = 1) {
    rules.softRules.teacherLoadBalance = {
        enabled: true,
        weight: Math.max(1, Math.min(10, Number.parseInt(weight, 10) || 1)),
        explicit: true,
    };
    rules.softRules.balancedTeacherLoad = true;
}

function setTeacherGapWeight(rules, weight = 1) {
    rules.softRules.teacherGapWeight = Math.max(1, Math.min(10, Number.parseInt(weight, 10) || 1));
}

function addSubjectSequence(rules, { beforeSubjectId, afterSubjectId, classIds = [], weight = 1 } = {}) {
    if (!beforeSubjectId || !afterSubjectId || beforeSubjectId === afterSubjectId) return;
    const classes = [...new Set(classIds.map(id => asText(id, 120)).filter(Boolean))].sort();
    const key = `${beforeSubjectId}|${afterSubjectId}|${classes.join('|')}`;
    const current = rules.softRules.subjectSequence || [];
    if (!current.some(item => `${item.beforeSubjectId}|${item.afterSubjectId}|${[...(item.classIds || [])].sort().join('|')}` === key)) {
        current.push({
            beforeSubjectId,
            afterSubjectId,
            classIds: classes,
            weight: Math.max(1, Math.min(10, Number.parseInt(weight, 10) || 1)),
        });
    }
    rules.softRules.subjectSequence = current;
}

function ensureComplexModel(project = {}) {
    project.timetableModelVersion = 'complex_v1';
    project.complexModelEnabled = true;
    project.campuses = Array.isArray(project.campuses) ? project.campuses : [];
    project.rooms = Array.isArray(project.rooms) ? project.rooms : [];
    project.teachingGroups = Array.isArray(project.teachingGroups) ? project.teachingGroups : [];
    project.commuteRules = project.commuteRules && typeof project.commuteRules === 'object'
        ? project.commuteRules
        : { defaultGapPeriods: 1, teacherGapPeriods: {} };
    project.rules = project.rules || {};
    project.rules.softRules = project.rules.softRules || {};
}

function ensureRoom(project = {}, room = {}) {
    const name = asText(room.name || room.roomName, 120);
    const id = asText(room.id, 120) || (name ? makeTimetableId('room', name) : '');
    if (!id || !name) return null;
    project.rooms = Array.isArray(project.rooms) ? project.rooms : [];
    let existing = project.rooms.find(item => item.id === id || item.name === name);
    if (!existing) {
        existing = {
            id,
            name,
            campusId: asText(room.campusId || room.campus, 120),
            capacity: Number.isInteger(Number(room.capacity)) ? Number(room.capacity) : 0,
            tags: [...new Set((room.tags || room.requiredTags || []).map(value => asText(value, 80)).filter(Boolean))],
        };
        project.rooms.push(existing);
    } else {
        existing.id = existing.id || id;
        existing.name = existing.name || name;
        if (room.campusId || room.campus) existing.campusId = asText(room.campusId || room.campus, 120);
        if (Number.isInteger(Number(room.capacity))) existing.capacity = Number(room.capacity);
        const tags = [...new Set([...(existing.tags || []), ...((room.tags || room.requiredTags || []).map(value => asText(value, 80)).filter(Boolean))])];
        existing.tags = tags;
    }
    return existing;
}

function lessonPlanTargetsForAction(project = {}, action = {}) {
    const explicitPlanIds = new Set((action.target?.lessonPlanIds || []).map(value => asText(value, 120)).filter(Boolean));
    const subjectIds = new Set((action.target?.subjectIds || []).map(value => asText(value, 120)).filter(Boolean));
    return (project.lessonPlans || []).filter(plan => (
        explicitPlanIds.has(plan.id)
        || (!explicitPlanIds.size && subjectIds.has(plan.subjectId))
    ));
}

function applyComplexModelPatch(project = {}, action = {}) {
    ensureComplexModel(project);
    let changed = false;
    const patch = action.patch || {};
    const targetPlans = lessonPlanTargetsForAction(project, action);

    if (patch.timetableModelVersion === 'complex_v1' || patch.complexModelEnabled === true) {
        changed = true;
    }

    if (patch.weekPattern) {
        const weekPattern = normalizeWeekPattern(patch.weekPattern);
        targetPlans.forEach(plan => {
            plan.weekPattern = weekPattern;
            changed = true;
        });
        const subjectIds = (action.target?.subjectIds || []).map(value => asText(value, 120)).filter(Boolean);
        if (subjectIds.length && (patch.preferredSlots?.length || patch.avoidSlots?.length)) {
            subjectIds.forEach(subjectId => addSubjectPeriodPreference(project.rules, subjectId, {
                prefer: patch.preferredSlots || [],
                avoid: patch.avoidSlots || [],
                weight: patch.weight || 30,
                weekPattern,
            }));
            changed = true;
        }
    }

    if (patch.roomRequirement && typeof patch.roomRequirement === 'object') {
        const roomIds = [...new Set([
            ...(patch.roomRequirement.preferredRoomIds || []),
            ...(patch.roomRequirement.roomIds || []),
        ].map(value => asText(value, 120)).filter(Boolean))];
        const roomName = asText(patch.roomRequirement.roomName || patch.roomRequirement.name, 120);
        if (roomName && !roomIds.length) {
            const room = ensureRoom(project, {
                id: makeTimetableId('room', roomName),
                name: roomName,
                tags: patch.roomRequirement.requiredTags || [],
                campusId: patch.roomRequirement.campusId,
                capacity: patch.roomRequirement.capacity,
            });
            if (room) roomIds.push(room.id);
        } else if (roomName && roomIds.length) {
            ensureRoom(project, {
                id: roomIds[0],
                name: roomName,
                tags: patch.roomRequirement.requiredTags || [],
                campusId: patch.roomRequirement.campusId,
                capacity: patch.roomRequirement.capacity,
            });
        }
        if (roomIds.length || patch.roomRequirement.requiredTags?.length) {
            targetPlans.forEach(plan => {
                plan.roomRequirement = {
                    ...(plan.roomRequirement || {}),
                    preferredRoomIds: [...new Set([...(plan.roomRequirement?.preferredRoomIds || []), ...roomIds])],
                    allowedRoomIds: [...new Set([...(plan.roomRequirement?.allowedRoomIds || []), ...(patch.roomRequirement.allowedRoomIds || [])])],
                    requiredTags: [...new Set([...(plan.roomRequirement?.requiredTags || []), ...(patch.roomRequirement.requiredTags || [])])],
                };
                if (roomIds[0]) {
                    plan.roomId = plan.roomId || roomIds[0];
                    plan.allowedRoomIds = [...new Set([...(plan.allowedRoomIds || []), ...roomIds])];
                }
                changed = true;
            });
        }
    }

    if (patch.teachingGroup && typeof patch.teachingGroup === 'object') {
        const classIds = [...new Set((patch.teachingGroup.classIds || []).map(value => asText(value, 120)).filter(Boolean))];
        const subjectIds = [...new Set((patch.teachingGroup.subjectIds || action.target?.subjectIds || []).map(value => asText(value, 120)).filter(Boolean))];
        const name = asText(patch.teachingGroup.name, 160)
            || [classIds.join('、'), subjectIds.join('、'), '教学组'].filter(Boolean).join('-');
        if (classIds.length && subjectIds.length) {
            const id = asText(patch.teachingGroup.id, 120) || makeTimetableId('tg', `${name}-${classIds.join('-')}-${subjectIds.join('-')}`);
            let group = (project.teachingGroups || []).find(item => item.id === id || item.name === name);
            if (!group) {
                group = {
                    id,
                    name,
                    mode: ['combined_class', 'rotation', 'split_class'].includes(patch.teachingGroup.mode) ? patch.teachingGroup.mode : 'combined_class',
                    classIds,
                    subjectIds,
                    teacherIds: [...new Set((patch.teachingGroup.teacherIds || []).map(value => asText(value, 120)).filter(Boolean))],
                    roomIds: [...new Set((patch.teachingGroup.roomIds || []).map(value => asText(value, 120)).filter(Boolean))],
                };
                project.teachingGroups.push(group);
            }
            (project.lessonPlans || [])
                .filter(plan => classIds.includes(plan.classId) && subjectIds.includes(plan.subjectId))
                .forEach(plan => {
                    plan.teachingGroupId = group.id;
                });
            changed = true;
        }
    }

    if (patch.commuteRules && typeof patch.commuteRules === 'object') {
        const defaultGap = Number.parseInt(patch.commuteRules.defaultGapPeriods ?? patch.commuteRules.defaultGap ?? patch.commuteRules.gapPeriods, 10);
        project.commuteRules = project.commuteRules || { defaultGapPeriods: 1, teacherGapPeriods: {} };
        if (Number.isInteger(defaultGap) && defaultGap >= 0) {
            project.commuteRules.defaultGapPeriods = Math.min(12, defaultGap);
            changed = true;
        }
        const teacherGapPeriods = patch.commuteRules.teacherGapPeriods || {};
        project.commuteRules.teacherGapPeriods = project.commuteRules.teacherGapPeriods || {};
        Object.entries(teacherGapPeriods).forEach(([teacherIdRaw, gapRaw]) => {
            const teacherId = asText(teacherIdRaw, 120);
            const gap = Number.parseInt(gapRaw, 10);
            if (teacherId && Number.isInteger(gap) && gap >= 0) {
                project.commuteRules.teacherGapPeriods[teacherId] = Math.min(12, gap);
                changed = true;
            }
        });
    }

    return changed;
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
    const idList = values => [...new Set((Array.isArray(values) ? values : [values])
        .map(value => asText(value, 120))
        .filter(Boolean))];
    return {
        id: asText(row.id, 120) || `rule_draft_${index + 1}`,
        requirementId: asText(row.requirementId || '', 120),
        stableKey: asText(row.stableKey || '', 240),
        parseSource: asText(row.parseSource || row.source || '', 80),
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
        teacherIds: idList(row.teacherIds || row.teachers || []),
        subjectIds: idList(row.subjectIds || row.subjects || []),
        classIds: idList(row.classIds || row.classes || []),
        roomIds: idList(row.roomIds || row.allowedRoomIds || row.rooms || []),
        roomName: asText(row.roomName || row.room || '', 200),
        requiredTags: idList(row.requiredTags || row.roomTags || []),
        beforeSubjectId: asText(row.beforeSubjectId || row.before || '', 120),
        afterSubjectId: asText(row.afterSubjectId || row.after || row.nextSubjectId || '', 120),
        slots,
        days: parseDays(row.days || row.weekdays || '', project, []),
        periods: parsePeriods(row.periods || row.lessonIndexes || '', project, []),
        priority: normalizePriority(row.priority || row.strength, type),
        status: status === 'ready' ? 'effective' : status,
        sourceStatus: STATUS_LABELS.has(row.status) ? row.status : '',
        confidence: row.confidence !== null && row.confidence !== undefined && Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
        description: asText(row.description || row.reason || row.note || '', 500),
        warnings: Array.isArray(row.warnings) ? row.warnings.map(item => asText(item, 200)).filter(Boolean) : [],
        aiReviewStatus: asText(row.aiReviewStatus || '', 40),
        aiReviewWarnings: Array.isArray(row.aiReviewWarnings) ? row.aiReviewWarnings.map(item => asText(item, 240)).filter(Boolean) : [],
        reviewEvidence: row.reviewEvidence && typeof row.reviewEvidence === 'object'
            ? {
                quote: asText(row.reviewEvidence.quote || row.reviewEvidence.text || '', 500),
                reason: asText(row.reviewEvidence.reason || row.reviewEvidence.message || '', 500),
                sourceSheet: asText(row.reviewEvidence.sourceSheet || '', 120),
                sourceRow: Number.parseInt(row.reviewEvidence.sourceRow, 10) || null,
            }
            : null,
        reviewedParseSource: asText(row.reviewedParseSource || '', 80),
        ambiguity: row.ambiguity || null,
        ambiguities: Array.isArray(row.ambiguities) ? row.ambiguities : [],
        weekPattern: asText(row.weekPattern || row.week || '', 60) || weekPatternFromText(rawText),
        weight: Number.parseInt(row.weight, 10) || undefined,
        limit: Number.parseInt(row.limit ?? row.value ?? row.max ?? row.count, 10) || undefined,
        minGapDays: Number.parseInt(row.minGapDays ?? row.gapDays ?? row.limit ?? row.value, 10) || undefined,
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
    return ['teacher_unavailable', 'class_unavailable', 'locked_slot', 'global_unavailable', 'subject_preferred_periods', 'subject_avoid_periods'].includes(type);
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
    if (next.status === 'suggestion') {
        next.status = 'effective';
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

    if ((type === 'teacher_daily_limit' || type === 'teacher_consecutive_limit' || type === 'teacher_weekly_limit' || type === 'teacher_max_days_per_week') && isAllTeachersTarget(next)) {
        next.targetType = 'all_teachers';
        next.targetId = '__all_teachers';
        next.targetName = '全部教师';
        next.priority = type === 'teacher_weekly_limit' || type === 'teacher_max_days_per_week' ? 'hard' : 'soft';
        next.confidence = next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence))
            ? Number(next.confidence)
            : 0.9;
        next.status = statusWithConfidence(next, next.confidence);
    }

    const targetType = targetTypeFor(type, next);
    if (['teacher', 'class', 'subject'].includes(targetType)) {
        next = applySingleTarget(next, project, targetType);
    }

    if (['teacher_daily_limit', 'teacher_consecutive_limit', 'teacher_weekly_limit', 'teacher_max_days_per_week', 'subject_daily_limit'].includes(type)
        && (!Number.isInteger(Number(next.limit)) || Number(next.limit) <= 0)) {
        next.status = 'needs_review';
        next.warnings.push('缺少有效的节数上限。');
    }
    if (type === 'course_interval' && (!Number.isInteger(Number(next.minGapDays)) || Number(next.minGapDays) <= 0)) {
        next.status = 'needs_review';
        next.warnings.push('缺少有效的间隔天数。');
    }
    if (type === 'room_requirement') {
        if (!(project.rooms || []).length) {
            next.status = 'needs_review';
            next.warnings.push('项目还没录入教室，先去基础数据添加教室后才能应用教室要求。');
        }
        if (!((next.roomIds || []).length || (next.requiredTags || []).length || next.roomName)) {
            next.status = 'needs_review';
            next.warnings.push('缺少教室、场地或教室标签。');
        }
    }
    if (type === 'teacher_mutual_exclusion' && (next.teacherIds || []).filter(Boolean).length < 2) {
        next.status = 'needs_review';
        next.warnings.push('教师互斥至少需要两位教师。');
    }
    if (type === 'subject_not_same_day' && (next.subjectIds || []).filter(Boolean).length < 2) {
        next.status = 'needs_review';
        next.warnings.push('课程不同天至少需要两门课程。');
    }
    if (type === 'subject_sequence' && !(next.beforeSubjectId && next.afterSubjectId)) {
        next.status = 'needs_review';
        next.warnings.push('课程顺序需要明确先上和后上的课程。');
    }

    if (next.confidence === null || next.confidence === undefined || !Number.isFinite(Number(next.confidence))) {
        next.confidence = next.status === 'effective' ? 0.9 : next.status === 'needs_review' ? 0.65 : 0.5;
    }
    next.status = statusWithConfidence(next, Number(next.confidence));
    if (next.weekPattern) {
        if (complexModelIsEnabled(project)) {
            next.status = next.status === 'invalid' ? 'invalid' : 'effective';
            next.confidence = Math.max(Number(next.confidence) || 0.9, 0.9);
        } else {
            next.status = 'needs_review';
            if (!next.warnings.some(warning => /单双周|不会自动生效/.test(warning))) {
                next.warnings.push('当前规则模型暂不支持单双周，不会自动生效。');
            }
            next.confidence = Math.min(Number(next.confidence) || 0.65, 0.68);
        }
    }
    return next;
}

function previewFromRow(row = {}) {
    return {
        id: row.id,
        stableKey: row.stableKey || '',
        parseSource: row.parseSource || row.source || '',
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
    rules.hardRules.globalUnavailable = [...(rules.hardRules.globalUnavailable || [])];
    rules.hardRules.subjectDailyLimit = { ...(rules.hardRules.subjectDailyLimit || {}) };
    rules.hardRules.teacherWeeklyLimit = { ...(rules.hardRules.teacherWeeklyLimit || {}) };
    rules.hardRules.teacherMaxDaysPerWeek = { ...(rules.hardRules.teacherMaxDaysPerWeek || {}) };
    rules.hardRules.teacherMutualExclusion = [...(rules.hardRules.teacherMutualExclusion || [])];
    rules.hardRules.subjectNotSameDay = [...(rules.hardRules.subjectNotSameDay || [])];
    rules.hardRules.roomRequirements = { ...(rules.hardRules.roomRequirements || {}) };
    rules.softRules = rules.softRules || {};
    rules.softRules.morningSubjects = [...(rules.softRules.morningSubjects || [])];
    rules.softRules.afternoonSubjects = [...(rules.softRules.afternoonSubjects || [])];
    rules.softRules.subjectPreferredPeriods = { ...(rules.softRules.subjectPreferredPeriods || {}) };
    rules.softRules.teacherLimits = { ...(rules.softRules.teacherLimits || {}) };
    rules.softRules.spreadSubjects = [...(rules.softRules.spreadSubjects || [])];
    rules.softRules.spreadSubjectGaps = { ...(rules.softRules.spreadSubjectGaps || {}) };
    rules.softRules.subjectDailySoftLimit = { ...(rules.softRules.subjectDailySoftLimit || {}) };
    rules.softRules.subjectSequence = [...(rules.softRules.subjectSequence || [])];
    rules.softRules.teacherGapWeight = Number.parseInt(rules.softRules.teacherGapWeight, 10) || 0;
    rules.softRules.classDailyBalance = { ...(rules.softRules.classDailyBalance || {}) };
    rules.softRules.teacherLoadBalance = { ...(rules.softRules.teacherLoadBalance || {}) };
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
        parseSource: row.parseSource || row.source || '',
        stableKey: row.stableKey || '',
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

function unsupportedComplexModelSupport(capability = '', message = '') {
    return {
        supported: false,
        capability: asText(capability, 80),
        requiredModel: 'complex_v1',
        phase: 'phase_2',
        message: asText(message || '当前需要复杂排课模型支持，暂不会自动生效。', 240),
    };
}

function complexModelIsEnabled(project = {}) {
    return project?.timetableModelVersion === 'complex_v1' || project?.complexModelEnabled === true;
}

function supportedComplexModelSupport(capability = '', message = '') {
    return {
        supported: true,
        capability: asText(capability, 80),
        requiredModel: 'complex_v1',
        phase: 'phase_2',
        message: asText(message || '已启用 complex_v1，可写入复杂排课模型字段。', 240),
    };
}

function modelSupportForRow(row = {}, project = {}) {
    if (row.weekPattern) {
        if (complexModelIsEnabled(project)) {
            return supportedComplexModelSupport('weekPattern', '已启用 complex_v1，单双周需求将写入模型字段。');
        }
        return unsupportedComplexModelSupport('weekPattern', '当前规则模型暂不支持单双周自动生效，需要 complex_v1 模型后参与求解。');
    }
    return null;
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
        global_unavailable: 'unavailable_periods',
        locked_slot: 'locked_slot',
        subject_morning: 'preferred_day_part',
        subject_afternoon: 'preferred_day_part',
        subject_preferred_periods: 'preferred_periods',
        subject_avoid_periods: 'avoid_periods',
        subject_daily_limit: 'subject_daily_limit',
        teacher_daily_limit: 'teacher_daily_limit',
        teacher_consecutive_limit: 'teacher_consecutive_limit',
        teacher_weekly_limit: 'teacher_weekly_limit',
        teacher_max_days_per_week: 'teacher_max_days_per_week',
        teacher_mutual_exclusion: 'teacher_mutual_exclusion',
        subject_spread: 'subject_spread',
        course_interval: 'course_interval',
        room_requirement: 'room_requirement',
        teacher_gap_preference: 'teacher_gap_preference',
        teacher_load_balance: 'teacher_load_balance',
        block_protection: 'block_integrity',
        class_daily_balance: 'class_daily_balance',
        class_subject_spread: 'class_subject_spread',
        quality_subject_later: 'quality_subject_later',
        subject_not_same_day: 'subject_not_same_day',
        subject_sequence: 'subject_sequence',
    };
    return map[row.type] || row.type || 'unknown';
}

function applyToForRow(row = {}, project = {}) {
    if (row.weekPattern && complexModelIsEnabled(project)) return 'model_extension';
    if (SUPPORTED_EFFECTIVE_TYPES.has(row.type)) return 'rule';
    if (row.type === 'class_subject_spread') return 'optimization';
    if (row.type === 'block_protection') return 'solver_policy';
    return row.status === 'ignored' ? 'solver_policy' : 'review';
}

function requirementStatusForRow(row = {}, project = {}) {
    if (row.weekPattern && complexModelIsEnabled(project) && row.status === 'effective') return 'actionable';
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

function requirementFromRow(row = {}, index = 0, project = {}) {
    return {
        id: `req_${row.id || index + 1}`,
        rowId: row.id || '',
        origin: 'user_input',
        object: rowRequirementObject(row),
        intent: intentForRow(row),
        condition: {
            ...(row.slots?.length ? { slots: row.slots } : {}),
            ...(row.weekPattern ? { weekPattern: row.weekPattern } : {}),
        },
        parameters: parametersForRow(row),
        strength: row.priority === 'hard' ? 'hard' : 'soft',
        status: requirementStatusForRow(row, project),
        applyTo: applyToForRow(row, project),
        confidence: row.confidence,
        source: sourceFromRow(row),
        warnings: row.warnings || [],
        modelSupport: modelSupportForRow(row, project),
    };
}

function requirementSourceText(item = {}) {
    return asText(item.source?.rawText || item.rawText || item.description || item.reason || item.reviewEvidence?.quote || '', 1200);
}

function rowSourceText(row = {}) {
    return asText(row.rawText || row.constraintText || row.text || row.description || row.reason || row.reviewEvidence?.quote || '', 1200);
}

function textFingerprint(value = '') {
    return asText(value, 1200)
        .replace(/\s+/g, '')
        .replace(/[，,。.;；：:、]/g, '')
        .toLowerCase();
}

function textLooksRelated(left = '', right = '') {
    const a = textFingerprint(left);
    const b = textFingerprint(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    return shorter.length >= 8 && longer.includes(shorter);
}

function slotsFromRequirementItem(item = {}, project = {}) {
    const params = item.parameters || item.params || {};
    const condition = item.condition || {};
    const direct = normalizeSlotList(params.slots || params.slotKeys || condition.slots || condition.slotKeys || []);
    if (direct.length) return direct;
    const days = parseDays(params.days || condition.days || item.days || '', project, []);
    const periods = parsePeriods(params.periods || condition.periods || item.periods || '', project, []);
    if (days.length && periods.length) {
        return [...new Set(days.flatMap(day => periods.map(period => slotKey(day, period))))].sort();
    }
    const source = requirementSourceText(item);
    const sourceDays = parseDays(source, project, []);
    const sourcePeriods = parsePeriods(source, project, []);
    if (sourceDays.length && sourcePeriods.length) {
        return [...new Set(sourceDays.flatMap(day => sourcePeriods.map(period => slotKey(day, period))))].sort();
    }
    return [];
}

function rowTargetIds(row = {}) {
    return [
        row.targetId,
        row.teacherId,
        row.classId,
        row.subjectId,
        ...(row.teacherIds || []),
        ...(row.classIds || []),
        ...(row.subjectIds || []),
    ].map(value => asText(value, 120)).filter(Boolean);
}

function rowTargetNames(row = {}) {
    return [
        row.targetName,
        row.teacherName,
        row.teacher,
        row.className,
        row.class,
        row.subjectName,
        row.subject,
    ].map(value => asText(value, 200)).filter(Boolean);
}

function requirementTargetIds(item = {}) {
    const params = item.parameters || item.params || {};
    return [
        item.targetId,
        item.object?.id,
        ...(item.object?.matchedIds || []),
        ...(params.teacherIds || []),
        ...(params.classIds || []),
        ...(params.subjectIds || []),
    ].map(value => asText(value, 120)).filter(Boolean);
}

function requirementTargetNames(item = {}) {
    const params = item.parameters || item.params || {};
    return [
        item.targetName,
        item.target,
        item.object?.name,
        ...(params.teacherNames || []),
        ...(params.classNames || []),
        ...(params.subjectNames || []),
    ].map(value => asText(value, 200)).filter(Boolean);
}

function normalizedEntityName(value = '') {
    return asText(value, 200).replace(/老师|教师|同学|班级|课程/g, '').replace(/\s+/g, '').toLowerCase();
}

function requirementTargetMatchesRow(item = {}, row = {}) {
    const reqIds = requirementTargetIds(item);
    const ids = rowTargetIds(row);
    if (reqIds.length && ids.some(id => reqIds.includes(id))) return true;
    const reqNames = requirementTargetNames(item).map(normalizedEntityName).filter(Boolean);
    const names = rowTargetNames(row).map(normalizedEntityName).filter(Boolean);
    if (reqNames.length && names.some(name => reqNames.includes(name))) return true;
    const source = normalizedEntityName(requirementSourceText(item));
    return Boolean(source && names.some(name => name && source.includes(name)));
}

function requirementIntentMatchesRow(item = {}, row = {}) {
    const intent = normalizeRequirementIntentAlias(item.intent || item.type || '');
    const rowIntent = normalizeRequirementIntentAlias(row.type || row.intent || '');
    if (!intent || intent === 'unknown' || intent === 'schedule_request') return true;
    if (intent === rowIntent) return true;
    if (intent === 'unavailable_periods' && ['teacher_unavailable', 'class_unavailable', 'global_unavailable'].includes(row.type)) return true;
    if (normalizeRequirementApplyToAlias(item.applyTo || '') === 'review') return true;
    return false;
}

function requirementTimeMatchesRow(item = {}, row = {}, project = {}) {
    const reqSlots = slotsFromRequirementItem(item, project);
    const slots = normalizeSlotList(row.slots || []);
    if (reqSlots.length && slots.length) {
        const reqSlotSet = new Set(reqSlots);
        return slots.some(slot => reqSlotSet.has(slot));
    }
    return textLooksRelated(requirementSourceText(item), rowSourceText(row));
}

function semanticRequirementMatchesRow(item = {}, row = {}, project = {}) {
    if (!item?.id || item.origin === 'system_supplement') return false;
    if (!requirementIntentMatchesRow(item, row)) return false;
    if (!requirementTargetMatchesRow(item, row)) return false;
    return requirementTimeMatchesRow(item, row, project);
}

function linkRowsToSemanticRequirements(rows = [], semanticRequirements = [], project = {}) {
    const requirements = externalRequirementItems(semanticRequirements)
        .filter(item => item.id && item.origin !== 'system_supplement');
    if (!requirements.length) return rows;
    return rows.map(row => {
        if (row.requirementId) return row;
        const matches = requirements.filter(item => semanticRequirementMatchesRow(item, row, project));
        if (matches.length !== 1) return row;
        return { ...row, requirementId: matches[0].id };
    });
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

function firstMentionedEntity(items = [], text = '', targetType = '') {
    const sourceText = asText(text, 1200);
    const candidates = [];
    for (const item of items || []) {
        const names = entityNamesForMatch(item, targetType)
            .filter(Boolean)
            .sort((left, right) => right.length - left.length);
        const matchedName = names.find(name => sourceText.includes(name));
        if (matchedName) {
            candidates.push({ item, index: sourceText.indexOf(matchedName), length: matchedName.length });
        }
    }
    candidates.sort((left, right) => left.index - right.index || right.length - left.length);
    return candidates[0]?.item || null;
}

function mentionedEntities(items = [], text = '', targetType = '') {
    const sourceText = asText(text, 1200);
    const candidates = [];
    const seen = new Set();
    for (const item of items || []) {
        const names = entityNamesForMatch(item, targetType)
            .filter(Boolean)
            .sort((left, right) => right.length - left.length);
        const matchedName = names.find(name => sourceText.includes(name));
        if (matchedName && !seen.has(item.id)) {
            seen.add(item.id);
            candidates.push({ item, index: sourceText.indexOf(matchedName), length: matchedName.length });
        }
    }
    return candidates
        .sort((left, right) => left.index - right.index || right.length - left.length)
        .map(candidate => candidate.item);
}

function maxConsecutiveAcrossCampusFromText(text = '') {
    const sourceText = asText(text, 400);
    const match = sourceText.match(new RegExp(`连续\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`));
    const value = match ? parseLooseNumber(match[1]) : null;
    if (!Number.isFinite(value) || value <= 0) return null;
    if (/不要|不能|避免|不许/.test(sourceText)) return Math.max(1, value - 1);
    return value;
}

function textRequirementBase(id, object, intent, sourceText, {
    condition = {},
    parameters = {},
    strength = 'soft',
    status = 'actionable',
    applyTo = 'review',
    confidence = 0.8,
    warnings = [],
    clarification = null,
    modelSupport = null,
    origin = '',
} = {}) {
    const inferredOrigin = origin
        || (/^req_(system|optimization|complex)_/.test(String(id || '')) ? 'system_supplement' : 'user_input');
    return {
        id,
        origin: inferredOrigin,
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
        clarification,
        modelSupport,
    };
}

function complexRequirementState(project = {}, capability = '', unsupportedMessage = '') {
    if (complexModelIsEnabled(project)) {
        return {
            status: 'actionable',
            modelSupport: supportedComplexModelSupport(capability, '已启用 complex_v1，可写入复杂排课模型字段。'),
            clarification: null,
            warnings: [],
        };
    }
    return {
        status: 'needs_review',
        modelSupport: unsupportedComplexModelSupport(capability, unsupportedMessage),
        clarification: {
            id: `clarify_${capability || 'complex_model'}_model_support`,
            kind: 'model_support',
            field: 'complexModel',
            question: '该需求需要先启用复杂排课模型后才能生效。',
            defaultValue: 'complex_v1',
        },
        warnings: [],
    };
}

function roomTagsFromText(roomName = '', sourceText = '') {
    const text = `${roomName} ${sourceText}`;
    const tags = [];
    if (/操场|体育馆|体育|运动|场地/.test(text)) tags.push('sport');
    if (/实验室|实验/.test(text)) tags.push('lab');
    if (/机房|信息|电脑|计算机/.test(text)) tags.push('computer');
    if (/音乐/.test(text)) tags.push('music');
    if (/美术/.test(text)) tags.push('art');
    return [...new Set(tags)];
}

function complexRequirementsFromText(project = {}, text = '') {
    const sourceText = asText(text, 1200);
    const requirements = [];

    if (/(跨校区|校区|通勤)/.test(sourceText) && /(连续|连着|间隔|赶课)/.test(sourceText)) {
        const teacher = firstMentionedEntity(project.teachers || [], sourceText, 'teacher');
        const maxConsecutive = maxConsecutiveAcrossCampusFromText(sourceText);
        const support = complexRequirementState(
            project,
            'campus_commute',
            '跨校区通勤需要 complex_v1 项目模型和求解器支持，当前不会自动生效。',
        );
        const object = teacher
            ? entityObject('teacher', teacher.name || entityLabel(teacher), teacher.id)
            : entityObject('teacher_group', '教师', [], 'derived');
        requirements.push(textRequirementBase(
            'req_complex_campus_commute_gap',
            object,
            'campus_commute_gap',
            sourceText,
            {
                parameters: {
                    commuteScope: 'cross_campus',
                    ...(maxConsecutive ? { maxConsecutiveAcrossCampus: maxConsecutive } : {}),
                },
                strength: 'hard',
                status: teacher && maxConsecutive && complexModelIsEnabled(project) ? support.status : 'needs_review',
                applyTo: 'model_extension',
                confidence: teacher ? 0.82 : 0.68,
                warnings: teacher ? support.warnings : ['未识别到唯一教师，当前只保留为跨校区通勤需求候选。'],
                modelSupport: support.modelSupport,
                clarification: teacher && maxConsecutive ? support.clarification : {
                    id: 'clarify_req_complex_campus_commute_parameters',
                    kind: 'model_support',
                    field: 'complexModel',
                    question: '跨校区通勤规则需要先确认教师和通勤间隔后才能生效。',
                    defaultValue: 'complex_v1',
                },
            },
        ));
    }

    if (/(合班|合上|走班|教学组)/.test(sourceText)) {
        const classes = mentionedEntities(project.classes || [], sourceText, 'class');
        const subject = firstMentionedEntity(project.subjects || [], sourceText, 'subject');
        const support = complexRequirementState(
            project,
            'teachingGroup',
            '合班/走班需要 complex_v1 教学组模型支持，当前不会自动生效。',
        );
        if (classes.length >= 2) {
            const classIds = classes.map(item => item.id).filter(Boolean);
            const classNames = classes.map(item => entityLabel(item)).filter(Boolean);
            requirements.push(textRequirementBase(
                'req_complex_teaching_group_session',
                entityObject('teaching_group', classNames.join('、') || '教学组', classIds, 'derived'),
                'teaching_group_session',
                sourceText,
                {
                    parameters: {
                        classIds,
                        classNames,
                        ...(subject?.id ? { subjectIds: [subject.id], subjectName: subject.name || entityLabel(subject) } : {}),
                        mode: /走班/.test(sourceText) ? 'rotation' : 'combined_class',
                    },
                    strength: /必须|不能|不要|固定/.test(sourceText) ? 'hard' : 'soft',
                    status: subject && complexModelIsEnabled(project) ? support.status : 'needs_review',
                    applyTo: 'model_extension',
                    confidence: subject ? 0.82 : 0.72,
                    warnings: subject ? support.warnings : ['未识别到唯一课程，当前只保留为教学组需求候选。'],
                    modelSupport: support.modelSupport,
                    clarification: subject ? support.clarification : {
                        id: 'clarify_req_complex_teaching_group_parameters',
                        kind: 'model_support',
                        field: 'complexModel',
                        question: '合班/走班需要先确认成员班级和课程后才能生效。',
                        defaultValue: 'complex_v1',
                    },
                },
            ));
        }
    }

    if (/(操场|体育馆|实验室|机房|音乐室|美术室|功能室|场地|教室)/.test(sourceText) && /(安排|排|上|使用|去|在)/.test(sourceText)) {
        const subject = firstMentionedEntity(project.subjects || [], sourceText, 'subject');
        const roomMatch = sourceText.match(/(操场|体育馆|实验室|机房|音乐室|美术室|功能室|[\u4e00-\u9fa5A-Za-z0-9_-]{1,12}(?:教室|场地|室|馆))/);
        const roomName = asText(roomMatch?.[1] || '', 120);
        const support = complexRequirementState(
            project,
            'room_attributes',
            '教室/场地偏好需要 complex_v1 教室属性模型支持，当前不会自动生效。',
        );
        if (subject && roomName) {
            requirements.push(textRequirementBase(
                'req_complex_room_requirement',
                entityObject('subject', subject.name || entityLabel(subject), subject.id),
                'room_requirement',
                sourceText,
                {
                    parameters: {
                        subjectIds: [subject.id],
                        roomName,
                        requiredTags: roomTagsFromText(roomName, sourceText),
                    },
                    strength: /必须|不能|不要|固定/.test(sourceText) ? 'hard' : 'soft',
                    status: complexModelIsEnabled(project) ? support.status : 'needs_review',
                    applyTo: 'model_extension',
                    confidence: 0.88,
                    modelSupport: support.modelSupport,
                    clarification: support.clarification,
                },
            ));
        }
    }

    return requirements;
}

function systemRequirementsFromText(text = '') {
    const requirements = [];
    const sourceText = asText(text, 1200);
    if (SYSTEM_TEACHER_TIME_CONFLICT_PATTERN.test(sourceText)) {
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
    if (SYSTEM_CLASS_TIME_CONFLICT_PATTERN.test(sourceText)) {
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
    if (SYSTEM_LESSON_HOURS_COMPLETENESS_PATTERN.test(sourceText)) {
        requirements.push(textRequirementBase(
            'req_system_lesson_hours_completeness',
            entityObject('global', '任课计划周课时', [], 'global'),
            'lesson_hours_completeness',
            sourceText,
            {
                strength: 'hard',
                status: 'handled',
                applyTo: 'solver_policy',
                confidence: 0.94,
                warnings: ['求解时会按任课计划周课时排满，不需要额外生成不可排规则。'],
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
    if (/高负载教师|教师.*负载|负载.*教师|连续.*太多|不要.*连续.*太多|(?:老师|教师).*课?.*太密|课.*太密/.test(sourceText)) {
        const teacherIds = highLoadTeacherIds(project);
        const names = teacherIds.length ? teacherNamesById(project, teacherIds).join('、') : '高负载教师';
        const thresholdMatch = sourceText.match(new RegExp(`(?:连续|连排).*?(?:最多|不超过|不多于|超过)\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`));
        const maxConsecutive = thresholdMatch ? parseLooseNumber(thresholdMatch[1]) : null;
        const needsClarification = !Number.isFinite(maxConsecutive) || maxConsecutive <= 0;
        requirements.push(textRequirementBase(
            'req_optimization_high_load_teachers',
            entityObject('derived_group', names, teacherIds, 'derived'),
            'teacher_load_protection',
            sourceText,
            {
                parameters: {
                    ...(needsClarification ? {} : { maxConsecutive }),
                    balancedTeacherLoad: true,
                },
                strength: 'soft',
                status: needsClarification ? 'needs_review' : 'actionable',
                applyTo: 'optimization',
                confidence: teacherIds.length ? 0.88 : 0.78,
                warnings: teacherIds.length ? [] : ['当前数据未识别出达到高负载阈值的教师，将先启用教师负载均衡目标。'],
                clarification: needsClarification ? {
                    id: 'clarify_req_optimization_high_load_teachers_max_consecutive',
                    kind: 'number',
                    field: 'maxConsecutive',
                    question: '连续超过几节算太多？',
                    defaultValue: 3,
                    min: 1,
                    max: Math.max(3, Number(project.periodsPerDay) || getActivePeriods(project).length || 8),
                } : null,
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

function normalizeRequirementIntentAlias(value = '') {
    const text = asText(value, 120).trim().toLowerCase().replace(/[-\s]+/g, '_');
    const compact = text.replace(/_/g, '');
    if (!text) return 'unknown';
    const aliases = {
        preferred_periods: 'preferred_periods',
        subject_preferred_periods: 'preferred_periods',
        period_preference: 'preferred_periods',
        periods_preference: 'preferred_periods',
        preferred_slots: 'preferred_periods',
        preferred_day_part: 'preferred_day_part',
        subject_morning: 'preferred_day_part',
        subject_afternoon: 'preferred_day_part',
        morning_preference: 'preferred_day_part',
        afternoon_preference: 'preferred_day_part',
        morning: 'preferred_day_part',
        afternoon: 'preferred_day_part',
        avoid_periods: 'avoid_periods',
        subject_avoid_periods: 'avoid_periods',
        unavailable_periods: 'unavailable_periods',
        teacher_unavailable: 'unavailable_periods',
        class_unavailable: 'unavailable_periods',
        global_unavailable: 'unavailable_periods',
        locked_slot: 'locked_slot',
        subject_daily_limit: 'subject_daily_limit',
        teacher_daily_limit: 'teacher_daily_limit',
        teacher_consecutive_limit: 'teacher_consecutive_limit',
        teacher_weekly_limit: 'teacher_weekly_limit',
        teacher_max_days_per_week: 'teacher_max_days_per_week',
        teacher_mutual_exclusion: 'teacher_mutual_exclusion',
        spread: 'subject_spread',
        subject_spread: 'subject_spread',
        course_spread: 'subject_spread',
        course_interval: 'course_interval',
        room_requirement: 'room_requirement',
        block: 'block_preference',
        block_preference: 'block_preference',
        double_block: 'block_preference',
        default_block_policy: 'default_block_policy',
        block_integrity: 'block_integrity',
        block_protection: 'block_integrity',
        teacher_gap_preference: 'teacher_gap_preference',
        teacher_load_balance: 'teacher_load_balance',
        teacher_load_protection: 'teacher_load_protection',
        teacher_time_conflict: 'teacher_time_conflict',
        class_time_conflict: 'class_time_conflict',
        class_daily_balance: 'class_daily_balance',
        class_subject_spread: 'class_subject_spread',
        quality_subject_later: 'quality_subject_later',
        subject_not_same_day: 'subject_not_same_day',
        subject_sequence: 'subject_sequence',
    };
    if (aliases[text]) return aliases[text];
    if (compact === 'morningpreference' || compact === 'subjectmorning') return 'preferred_day_part';
    if (compact === 'periodpreference' || compact === 'preferredslots') return 'preferred_periods';
    if (compact === 'spread' || compact === 'subjectspread' || compact === 'coursespread') return 'subject_spread';
    return text;
}

function normalizeRequirementStatusAlias(value = '') {
    const text = asText(value, 40).trim().toLowerCase().replace(/[-\s]+/g, '_');
    if (!text) return 'needs_review';
    if (['handled', 'ignored', 'system_handled', 'already_handled'].includes(text)) return 'handled';
    if (['actionable', 'ready', 'effective', 'applicable'].includes(text)) return 'actionable';
    if (['needs_review', 'need_review', 'review', 'pending_review', 'candidate', 'pending', 'draft'].includes(text)) return 'needs_review';
    return 'needs_review';
}

function normalizeRequirementApplyToAlias(value = '') {
    const text = asText(value, 80).trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
    return {
        rules: 'rule',
        constraint: 'rule',
        constraint_rule: 'rule',
        lesson_plan: 'lesson_plan',
        lesson_plans: 'lesson_plan',
        lessonplan: 'lesson_plan',
        roster: 'lesson_plan',
        optimization: 'optimization',
        optimize: 'optimization',
        solver_policy: 'solver_policy',
        system_policy: 'solver_policy',
        handled: 'solver_policy',
        review: 'review',
        needs_review: 'review',
    }[text] || text || 'review';
}

function normalizeRequirementClarification(clarification = null, requirementId = '') {
    if (!clarification || typeof clarification !== 'object') return null;
    const field = asText(clarification.field || 'value', 80);
    const kind = asText(clarification.kind || clarification.type || 'text', 40);
    const id = asText(clarification.id, 160) || `clarify_${requirementId || 'requirement'}_${field}`;
    const result = {
        id,
        kind,
        field,
        question: asText(clarification.question || '请补充这个需求的必要参数。', 240),
        defaultValue: clarification.defaultValue ?? clarification.default ?? null,
        value: clarification.value ?? null,
        options: Array.isArray(clarification.options)
            ? clarification.options.map(option => ({
                label: asText(option.label || option.name || option.value || option.id, 120),
                value: asText(option.value || option.id || option.label, 120),
            })).filter(option => option.label && option.value)
            : [],
    };
    if (clarification.min !== undefined && clarification.min !== null && Number.isFinite(Number(clarification.min))) {
        result.min = Number(clarification.min);
    }
    if (clarification.max !== undefined && clarification.max !== null && Number.isFinite(Number(clarification.max))) {
        result.max = Number(clarification.max);
    }
    return result;
}

function normalizeRequirementModelSupport(modelSupport = null) {
    if (!modelSupport || typeof modelSupport !== 'object') return null;
    return {
        supported: Boolean(modelSupport.supported),
        capability: asText(modelSupport.capability || modelSupport.kind || '', 80),
        requiredModel: asText(modelSupport.requiredModel || modelSupport.model || '', 80),
        phase: asText(modelSupport.phase || '', 80),
        message: asText(modelSupport.message || modelSupport.reason || '', 240),
    };
}

function externalRequirementItems(items = []) {
    return (Array.isArray(items) ? items : []).map((item, index) => {
        const id = asText(item.id, 120) || `req_external_${index + 1}`;
        const sourceRawText = asText(
            item.source?.rawText
            || item.source?.text
            || item.rawText
            || item.reason
            || item.description
            || item.reviewEvidence?.quote
            || '',
            1000
        );
        const source = item.source && typeof item.source === 'object'
            ? { ...item.source, rawText: sourceRawText }
            : { rawText: sourceRawText };
        return {
            id,
            object: item.object && typeof item.object === 'object'
                ? {
                    kind: asText(item.object.kind || item.object.type || 'global', 80),
                    name: asText(item.object.name || item.object.label || item.targetName || item.target || '', 200),
                    matchedIds: Array.isArray(item.object.matchedIds) ? item.object.matchedIds.map(value => asText(value, 120)).filter(Boolean) : [],
                    scope: asText(item.object.scope || 'explicit', 80),
                }
                : entityObject(asText(item.targetType || 'global', 80), asText(item.targetName || item.target || '', 200), item.targetId || '', 'explicit'),
            intent: normalizeRequirementIntentAlias(item.intent || item.type || 'unknown'),
            condition: item.condition && typeof item.condition === 'object' ? item.condition : {},
            parameters: item.parameters && typeof item.parameters === 'object' ? item.parameters : {},
            strength: asText(item.strength || item.priority || 'soft', 40),
            status: normalizeRequirementStatusAlias(item.status || 'needs_review'),
            applyTo: normalizeRequirementApplyToAlias(item.applyTo || 'review'),
            confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
            clarificationHistory: Array.isArray(item.clarificationHistory)
                ? item.clarificationHistory.map(entry => ({
                    question: asText(entry.question || '', 500),
                    field: asText(entry.field || '', 80),
                    kind: asText(entry.kind || '', 40),
                    answer: entry.answer,
                    answerLabel: asText(entry.answerLabel || '', 200),
                    at: asText(entry.at || '', 80),
                }))
                : [],
            source,
            warnings: Array.isArray(item.warnings) ? item.warnings.map(value => asText(value, 240)).filter(Boolean) : [],
            aiReviewStatus: asText(item.aiReviewStatus || '', 40),
            aiReviewWarnings: Array.isArray(item.aiReviewWarnings) ? item.aiReviewWarnings.map(value => asText(value, 240)).filter(Boolean) : [],
            reviewEvidence: item.reviewEvidence && typeof item.reviewEvidence === 'object'
                ? {
                    quote: asText(item.reviewEvidence.quote || item.reviewEvidence.text || '', 500),
                    reason: asText(item.reviewEvidence.reason || item.reviewEvidence.message || '', 500),
                    sourceSheet: asText(item.reviewEvidence.sourceSheet || '', 120),
                    sourceRow: Number.parseInt(item.reviewEvidence.sourceRow, 10) || null,
                }
                : null,
            reviewedParseSource: asText(item.reviewedParseSource || '', 80),
            clarification: normalizeRequirementClarification(item.clarification, id),
            modelSupport: normalizeRequirementModelSupport(item.modelSupport),
        };
    });
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
        const teacherLimits = { consecutive: requirement.parameters?.maxConsecutive || 3 };
        const dailyLimit = Number(requirement.parameters?.maxDaily || requirement.parameters?.dailyLimit);
        if (Number.isFinite(dailyLimit) && dailyLimit > 0) teacherLimits.daily = dailyLimit;
        return {
            id: `act_${requirement.id || index + 1}`,
            requirementId: requirement.id,
            kind: 'soft_rules_patch',
            target: { teacherIds: requirement.object?.matchedIds || [], derivedGroup: 'high_load_teachers' },
            patch: {
                balancedTeacherLoad: true,
                teacherLimits,
            },
            status: 'ready',
            requiresConfirmation: true,
        };
    }
    if (requirement.applyTo === 'model_extension') {
        if (!complexModelIsEnabled(project) || requirement.modelSupport?.supported === false) {
            return null;
        }
        if (requirement.intent === 'preferred_periods' && requirement.parameters?.weekPattern) {
            const subjectIds = requirement.object?.matchedIds || [];
            return {
                id: `act_${requirement.id || index + 1}`,
                requirementId: requirement.id,
                kind: 'complex_model_patch',
                target: { subjectIds },
                patch: {
                    weekPattern: requirement.parameters.weekPattern,
                    preferredSlots: requirement.parameters.slots || [],
                },
                status: subjectIds.length ? 'ready' : 'needs_review',
                requiresConfirmation: true,
            };
        }
        if (requirement.intent === 'avoid_periods' && requirement.parameters?.weekPattern) {
            const subjectIds = requirement.object?.matchedIds || [];
            return {
                id: `act_${requirement.id || index + 1}`,
                requirementId: requirement.id,
                kind: 'complex_model_patch',
                target: { subjectIds },
                patch: {
                    weekPattern: requirement.parameters.weekPattern,
                    avoidSlots: requirement.parameters.slots || [],
                },
                status: subjectIds.length ? 'ready' : 'needs_review',
                requiresConfirmation: true,
            };
        }
        if (requirement.intent === 'campus_commute_gap') {
            const teacherIds = requirement.object?.kind === 'teacher' ? requirement.object?.matchedIds || [] : [];
            const maxConsecutive = Number.parseInt(requirement.parameters?.maxConsecutiveAcrossCampus, 10);
            const gap = Number.isInteger(maxConsecutive) ? Math.max(0, maxConsecutive) : 1;
            return {
                id: `act_${requirement.id || index + 1}`,
                requirementId: requirement.id,
                kind: 'complex_model_patch',
                target: { teacherIds },
                patch: {
                    commuteRules: {
                        defaultGapPeriods: gap,
                        teacherGapPeriods: Object.fromEntries(teacherIds.map(teacherId => [teacherId, gap])),
                    },
                },
                status: teacherIds.length ? 'ready' : 'needs_review',
                requiresConfirmation: true,
            };
        }
        if (requirement.intent === 'teaching_group_session') {
            const classIds = requirement.parameters?.classIds || requirement.object?.matchedIds || [];
            const subjectIds = requirement.parameters?.subjectIds || [];
            return {
                id: `act_${requirement.id || index + 1}`,
                requirementId: requirement.id,
                kind: 'complex_model_patch',
                target: { classIds, subjectIds },
                patch: {
                    teachingGroup: {
                        name: requirement.object?.name || '教学组',
                        classIds,
                        subjectIds,
                        mode: requirement.parameters?.mode || 'combined_class',
                    },
                },
                status: classIds.length >= 2 && subjectIds.length ? 'ready' : 'needs_review',
                requiresConfirmation: true,
            };
        }
        if (requirement.intent === 'room_requirement') {
            const subjectIds = requirement.parameters?.subjectIds || requirement.object?.matchedIds || [];
            const roomName = asText(requirement.parameters?.roomName, 120);
            return {
                id: `act_${requirement.id || index + 1}`,
                requirementId: requirement.id,
                kind: 'complex_model_patch',
                target: { subjectIds },
                patch: {
                    roomRequirement: {
                        roomName,
                        requiredTags: requirement.parameters?.requiredTags || [],
                    },
                },
                status: subjectIds.length && roomName ? 'ready' : 'needs_review',
                requiresConfirmation: true,
            };
        }
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
        ...complexRequirementsFromText(project, originalText),
    ];
    const rowRequirements = rows.map((row, index) => requirementFromRow(row, index, project));
    const requirementItems = dedupeRequirements([
        ...externalRequirementItems(semanticRequirements),
        ...textRequirements,
        ...rowRequirements,
    ]).map(item => (item.status === 'needs_review' ? applyClarificationPolicy(project, item) : item));
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

        if (kind === 'complex_model_patch') {
            const changed = applyComplexModelPatch(next, action);
            if (changed) {
                applied.push({ id, kind });
            } else {
                needsReview.push({ id, kind, reason: '没有可写入的复杂模型参数。' });
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

function buildRequirementClarifyingQuestions(requirementItems = []) {
    const seen = new Set();
    return (Array.isArray(requirementItems) ? requirementItems : []).flatMap(item => {
        const clarification = normalizeRequirementClarification(item?.clarification, item?.id || '');
        if (!clarification) return [];
        const requirementId = asText(item.id, 120);
        const id = clarification.id || `clarify_${requirementId}_${clarification.field || 'value'}`;
        if (seen.has(id)) return [];
        seen.add(id);
        return [{
            id,
            requirementId,
            question: clarification.question,
            reason: '这个需求缺少必要参数，系统不会自动猜测。',
            kind: clarification.kind,
            field: clarification.field,
            defaultValue: clarification.defaultValue,
            min: clarification.min,
            max: clarification.max,
            options: clarification.options || [],
            relatedRequirementIds: requirementId ? [requirementId] : [],
        }];
    });
}

function detectRuleConflicts(project = {}, draftRows = []) {
    const conflicts = [];
    const teacherUnavailable = new Map();
    const classUnavailable = new Map();
    const subjectAvoid = new Map();
    const teacherLimits = new Map();
    const teacherWeeklyLimits = new Map();
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
    Object.entries(project.rules?.hardRules?.teacherWeeklyLimit || {}).forEach(([teacherId, limit]) => {
        if (Number.isInteger(Number(limit))) teacherWeeklyLimits.set(teacherId, { limit: Number(limit), ruleId: 'saved_teacher_weekly_limit' });
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
        if (row.type === 'global_unavailable') {
            (project.classes || []).forEach(klass => addMapSlots(classUnavailable, klass.id, row.slots, row.id));
        }
        if (row.type === 'teacher_daily_limit') {
            if (isAllTeachersTarget(row)) {
                (project.teachers || []).forEach(teacher => {
                    teacherLimits.set(teacher.id, { limit: row.limit, ruleId: row.id });
                });
            } else {
                teacherLimits.set(row.targetId, { limit: row.limit, ruleId: row.id });
            }
        }
        if (row.type === 'teacher_weekly_limit') {
            if (isAllTeachersTarget(row)) {
                (project.teachers || []).forEach(teacher => {
                    teacherWeeklyLimits.set(teacher.id, { limit: row.limit, ruleId: row.id });
                });
            } else {
                teacherWeeklyLimits.set(row.targetId, { limit: row.limit, ruleId: row.id });
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

    teacherWeeklyLimits.forEach(({ limit, ruleId }, teacherId) => {
        if (!Number.isInteger(Number(limit)) || Number(limit) <= 0) return;
        const load = (project.lessonPlans || []).reduce((sum, plan) => {
            const ids = [...new Set([...(plan.teacherIds || []), plan.teacherId].filter(Boolean))];
            return ids.includes(teacherId) ? sum + (Number.parseInt(plan.weeklyHours, 10) || 0) : sum;
        }, 0);
        if (load > Number(limit)) {
            const teacher = (project.teachers || []).find(item => item.id === teacherId);
            conflicts.push({
                level: 'blocking',
                message: `${teacher?.name || teacherId} 每周上限 ${Number(limit)} 节，但任课计划共 ${load} 节，无解。`,
                relatedRuleIds: [ruleId].filter(Boolean),
                suggestion: '请放宽教师每周上限，或调整该教师任课计划课时。',
            });
        }
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
    parserVersion = PARSER_VERSION,
    parseSource = source,
    cacheHit = false,
}) {
    const conflicts = detectRuleConflicts(project, rows);
    const clarifyingQuestions = [
        ...buildClarifyingQuestions(project, rows),
        ...buildRequirementClarifyingQuestions(requirementItems),
    ];
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
        parseSource: parseSource || source,
        inputType,
        contextStats,
        parserVersion,
        cacheHit: Boolean(cacheHit),
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

function requirementAnswerKey(answer = {}) {
    return [
        asText(answer.requirementId || answer.id || '', 120),
        asText(answer.field || '', 80),
    ].join(':');
}

function requirementObjectKey(object = {}) {
    return JSON.stringify([
        asText(object?.kind || '', 80),
        asText(object?.name || '', 200),
        Array.isArray(object?.matchedIds) ? object.matchedIds.map(value => asText(value, 120)).filter(Boolean).sort() : [],
    ]);
}

function looseRequirementObjectKey(object = {}) {
    return JSON.stringify([
        asText(object?.kind || '', 80),
        asText(object?.name || '', 200),
    ]);
}

function normalizeClarificationValue(clarification = null, rawValue = null) {
    if (clarification?.kind === 'number') {
        const value = Number(rawValue);
        if (!Number.isFinite(value)) return rawValue;
        const min = Number.isFinite(Number(clarification.min)) ? Number(clarification.min) : null;
        const max = Number.isFinite(Number(clarification.max)) ? Number(clarification.max) : null;
        return Math.min(max ?? value, Math.max(min ?? value, value));
    }
    return rawValue;
}

function selectedOptionLabel(clarification = {}, value = '') {
    const option = (clarification.options || []).find(item => String(item.value ?? item.id ?? item.label) === String(value));
    return asText(option?.label || option?.name || '', 200);
}

function applyRequirementClarifyingAnswers(requirementItems = [], answers = [], project = {}) {
    const answerMap = new Map((Array.isArray(answers) ? answers : []).map(answer => [
        requirementAnswerKey(answer),
        answer,
    ]));
    if (!answerMap.size) return requirementItems;
    const itemById = new Map((Array.isArray(requirementItems) ? requirementItems : [])
        .map(item => [asText(item?.id, 120), item])
        .filter(([id]) => id));
    const answeredSignatures = new Map();
    const looseAnsweredSignatures = new Map();
    (Array.isArray(answers) ? answers : []).forEach(answer => {
        const requirement = itemById.get(asText(answer.requirementId || answer.id, 120));
        if (!requirement) return;
        const signature = [
            normalizeRequirementIntentAlias(requirement.intent || ''),
            normalizeRequirementApplyToAlias(requirement.applyTo || ''),
            requirementObjectKey(requirement.object || {}),
            asText(answer.field || '', 80),
        ];
        answeredSignatures.set(JSON.stringify(signature), answer);
        looseAnsweredSignatures.set(JSON.stringify([
            signature[0],
            signature[1],
            looseRequirementObjectKey(requirement.object || {}),
            signature[3],
        ]), answer);
    });
    return (Array.isArray(requirementItems) ? requirementItems : []).map(item => {
        const next = cloneValue(item);
        const clarification = normalizeRequirementClarification(next.clarification, next.id || '');
        if (!clarification) return next;
        const directAnswer = answerMap.get(requirementAnswerKey({
            requirementId: next.id,
            field: clarification.field,
        }));
        const signatureAnswer = answeredSignatures.get(JSON.stringify([
            normalizeRequirementIntentAlias(next.intent || ''),
            normalizeRequirementApplyToAlias(next.applyTo || ''),
            requirementObjectKey(next.object || {}),
            clarification.field,
        ]));
        const looseSignatureAnswer = looseAnsweredSignatures.get(JSON.stringify([
            normalizeRequirementIntentAlias(next.intent || ''),
            normalizeRequirementApplyToAlias(next.applyTo || ''),
            looseRequirementObjectKey(next.object || {}),
            clarification.field,
        ]));
        const answer = directAnswer || signatureAnswer || looseSignatureAnswer;
        if (!answer || answer.value === undefined || answer.value === null || String(answer.value).trim() === '') return next;
        const value = normalizeClarificationValue(clarification, answer.value);
        next.parameters = {
            ...(next.parameters && typeof next.parameters === 'object' ? next.parameters : {}),
            [clarification.field]: value,
        };
        next.clarificationHistory = [
            ...(Array.isArray(next.clarificationHistory) ? next.clarificationHistory : []),
            {
                question: clarification.question || '',
                field: clarification.field || '',
                kind: clarification.kind || '',
                answer: value,
                answerLabel: answer.label || selectedOptionLabel(clarification, value) || String(value),
                at: new Date().toISOString(),
            },
        ];
        const policyResult = applyClarificationPolicy(project, {
            ...next,
            status: 'actionable',
            clarification: null,
        });
        next.parameters = policyResult.parameters || next.parameters;
        next.status = policyResult.status || 'actionable';
        next.applyTo = policyResult.applyTo || next.applyTo;
        next.clarification = policyResult.clarification || null;
        next.confidence = Math.max(Number(next.confidence) || 0, 0.86);
        next.warnings = (next.warnings || []).filter(warning => !/缺少|补充|确认/.test(warning));
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

export function continueTimetableRequirementClarification({
    project: inputProject = {},
    previousResult = {},
    answers = [],
    inputType = 'requirement_clarification',
    contextStats = null,
} = {}) {
    const project = normalizeTimetableProject(inputProject);
    const rows = Array.isArray(previousResult?.draftRows) ? cloneValue(previousResult.draftRows) : [];
    const requirementItems = applyRequirementClarifyingAnswers(
        externalRequirementItems(previousResult?.requirementItems || []),
        answers,
        project,
    );
    const semanticActions = requirementItems
        .map((requirement, index) => actionForRequirement(project, requirement, index))
        .filter(Boolean);
    return buildRuleReviewResult({
        project,
        draftRules: previousResult?.draftRules || emptyRulesFrom(project),
        rows,
        previewItems: previousResult?.previewItems || previewRows(rows),
        requirementItems,
        semanticActions,
        warnings: previousResult?.warnings || [],
        unsupportedItems: previousResult?.unsupportedItems || [],
        source: 'clarification',
        inputType: inputType || previousResult?.inputType || 'requirement_clarification',
        contextStats: contextStats || previousResult?.contextStats || null,
        parserVersion: previousResult?.parserVersion || PARSER_VERSION,
        parseSource: previousResult?.parseSource || 'clarification',
        cacheHit: false,
    });
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

function rowIdentityNeedsStabilizing(row = {}, source = '') {
    return ['local_xlsx', 'ai_supplement', 'cache', 'mixed_xlsx'].includes(row.parseSource || source);
}

function stableRowSortKey(row = {}) {
    return [
        row.sourceSheet || '',
        String(row.sourceRow || '').padStart(6, '0'),
        row.type || '',
        row.targetId || row.targetName || row.teacherId || row.classId || row.subjectId || '',
        (row.slots || []).join(','),
        row.rawText || '',
    ].join('|');
}

function stableKeyForRow(row = {}) {
    return hashValue({
        sourceSheet: row.sourceSheet || '',
        sourceRow: row.sourceRow || null,
        type: row.type || '',
        targetType: row.targetType || '',
        targetId: row.targetId || '',
        targetName: row.targetName || '',
        teacherId: row.teacherId || '',
        classId: row.classId || '',
        subjectId: row.subjectId || '',
        slots: row.slots || [],
        days: row.days || [],
        periods: row.periods || [],
        limit: row.limit || null,
        weekPattern: row.weekPattern || '',
        rawText: row.rawText || '',
    }, 20);
}

function stabilizeParsedRows(rows = [], source = '') {
    return [...rows]
        .sort((left, right) => stableRowSortKey(left).localeCompare(stableRowSortKey(right), 'zh-Hans-CN'))
        .map((row, index) => {
            if (!rowIdentityNeedsStabilizing(row, source)) return row;
            const stableKey = row.stableKey || stableKeyForRow(row);
            return {
                ...row,
                stableKey,
                id: `rule_${stableKey}`,
                parseSource: row.parseSource || source,
                source: row.source || row.parseSource || source,
                sourceOrder: index + 1,
            };
        });
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
    let unsupportedItems = [];
    const compiledRows = (Array.isArray(semanticRequirements) ? semanticRequirements : [])
        .flatMap((requirement, index) => {
            const rows = compileRequirementToRows(requirement, project);
            if (!rows) return [];
            return rows.map((row, rowIndex) => ({
                ...row,
                id: row.id || `compiled_${index + 1}_${rowIndex + 1}`,
                requirementId: requirement.id || row.requirementId || '',
                origin: requirement.origin || row.origin || 'user_input',
            }));
        });

    const filteredDraftRows = [...(Array.isArray(draftRows) ? draftRows : []), ...compiledRows]
        .filter(row => !isSystemHandledDraftRow(row));

    let rows = filteredDraftRows
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

            if (row.type === 'global_unavailable') {
                if (!slots.length) {
                    const reason = '全校不可排缺少明确节次，请复核。';
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'global', targetName: '全校', warnings: [...row.warnings, reason] };
                }
                addGlobalUnavailable(rules, slots);
                return { ...row, targetType: 'global', targetId: '__global__', targetName: '全校', priority: 'hard', status: 'effective' };
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

            if (row.type === 'subject_afternoon') {
                if (!target) {
                    const reason = `${row.targetName || row.targetId || '课程'} 缺少可匹配课程，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'subject', warnings: [...row.warnings, reason] };
                }
                addAfternoonSubject(rules, target.id);
                return { ...row, targetType, targetId: target.id, targetName: target.name || row.targetName, priority: 'soft', status: 'effective' };
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

            if (row.type === 'subject_daily_limit') {
                const limit = Number.parseInt(row.limit ?? row.weight ?? row.value, 10);
                if (!target || !Number.isInteger(limit) || limit <= 0) {
                    const reason = `${row.targetName || row.targetId || '课程'} 缺少可匹配课程或有效的每日上限，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'subject', warnings: [...row.warnings, reason] };
                }
                addSubjectDailyLimit(rules, target.id, limit);
                return { ...row, targetType: 'subject', targetId: target.id, targetName: target.name || row.targetName, priority: 'hard', status: 'effective' };
            }

            if (row.type === 'teacher_daily_limit' || row.type === 'teacher_consecutive_limit' || row.type === 'teacher_weekly_limit' || row.type === 'teacher_max_days_per_week') {
                const limit = Number.parseInt(row.limit ?? row.weight ?? row.value, 10);
                if (isAllTeachersTarget(row)) {
                    if (!Number.isInteger(limit) || limit <= 0 || !(project.teachers || []).length) {
                        const reason = `${row.targetName || '全部教师'} 缺少有效的节数上限或当前项目没有教师，请复核。`;
                        warnings.push(reason);
                        return { ...row, status: 'needs_review', targetType: 'all_teachers', targetId: '__all_teachers', targetName: '全部教师', warnings: [...row.warnings, reason] };
                    }
                    (project.teachers || []).forEach(teacher => {
                        if (row.type === 'teacher_daily_limit') addTeacherLimit(rules, teacher.id, { daily: limit });
                        else if (row.type === 'teacher_consecutive_limit') addTeacherLimit(rules, teacher.id, { consecutive: limit });
                        else if (row.type === 'teacher_weekly_limit') addTeacherWeeklyLimit(rules, teacher.id, limit);
                        else addTeacherMaxDaysPerWeek(rules, teacher.id, limit);
                    });
                    return { ...row, targetType: 'all_teachers', targetId: '__all_teachers', targetName: '全部教师', priority: ['teacher_weekly_limit', 'teacher_max_days_per_week'].includes(row.type) ? 'hard' : 'soft', status: 'effective' };
                }
                const teacher = findEntity(project.teachers, row);
                if (!teacher || !Number.isInteger(limit) || limit <= 0) {
                    const reason = `${row.targetName || row.targetId || '教师'} 缺少可匹配教师或有效的节数上限，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'teacher', warnings: [...row.warnings, reason] };
                }
                if (row.type === 'teacher_daily_limit') addTeacherLimit(rules, teacher.id, { daily: limit });
                else if (row.type === 'teacher_consecutive_limit') addTeacherLimit(rules, teacher.id, { consecutive: limit });
                else if (row.type === 'teacher_weekly_limit') addTeacherWeeklyLimit(rules, teacher.id, limit);
                else addTeacherMaxDaysPerWeek(rules, teacher.id, limit);
                return { ...row, targetType: 'teacher', targetId: teacher.id, targetName: teacher.name || row.targetName, priority: ['teacher_daily_limit', 'teacher_consecutive_limit'].includes(row.type) ? 'soft' : 'hard', status: 'effective' };
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

            if (row.type === 'course_interval') {
                const minGapDays = Number.parseInt(row.minGapDays ?? row.limit ?? row.value, 10);
                if (!target || !Number.isInteger(minGapDays) || minGapDays <= 0) {
                    const reason = `${row.targetName || row.targetId || '课程'} 缺少可匹配课程或有效间隔天数，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'subject', warnings: [...row.warnings, reason] };
                }
                addCourseInterval(rules, target.id, minGapDays);
                return { ...row, targetType: 'subject', targetId: target.id, targetName: target.name || row.targetName, minGapDays, priority: 'soft', status: 'effective' };
            }

            if (row.type === 'room_requirement') {
                if (!target) {
                    const reason = `${row.targetName || row.targetId || '课程'} 缺少可匹配课程，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'subject', warnings: [...row.warnings, reason] };
                }
                const roomMatches = resolveEntityList(project.rooms || [], [...(row.roomIds || []), row.roomName].filter(Boolean));
                const roomIds = roomMatches.map(room => room.id);
                const requiredTags = row.requiredTags || roomTagsFromText(row.roomName, row.rawText || row.description || '');
                if (!roomIds.length && !requiredTags.length) {
                    const reason = '教室要求缺少可匹配教室或教室标签，请复核。';
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'subject', warnings: [...row.warnings, reason] };
                }
                addRoomRequirement(rules, target.id, { roomIds, requiredTags });
                return { ...row, targetType: 'subject', targetId: target.id, targetName: target.name || row.targetName, roomIds, requiredTags, priority: 'hard', status: 'effective' };
            }

            if (row.type === 'class_daily_balance') {
                setClassDailyBalance(rules, { mainSubjectDailyMax: row.limit || row.mainSubjectDailyMax || 0 });
                return { ...row, targetType: 'global', targetId: '__all_classes', targetName: '全部班级', priority: 'soft', status: 'effective' };
            }

            if (row.type === 'teacher_gap_preference') {
                setTeacherGapWeight(rules, row.weight || row.limit || 1);
                return { ...row, targetType: 'global', targetId: '__all_teachers', targetName: '全部教师', priority: 'soft', status: 'effective' };
            }

            if (row.type === 'teacher_load_balance') {
                setTeacherLoadBalance(rules, row.weight || row.limit || 1);
                return { ...row, targetType: 'global', targetId: '__all_teachers', targetName: '全部教师', priority: 'soft', status: 'effective' };
            }

            if (row.type === 'teacher_mutual_exclusion') {
                const teachers = resolveEntityList(project.teachers || [], row.teacherIds || []);
                if (teachers.length < 2) {
                    const reason = '教师互斥至少需要两位可匹配教师，请复核。';
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'global', warnings: [...row.warnings, reason] };
                }
                addTeacherMutualExclusion(rules, teachers.map(teacher => teacher.id));
                return { ...row, teacherIds: teachers.map(teacher => teacher.id), targetType: 'global', targetId: teachers.map(teacher => teacher.id).join('|'), targetName: teachers.map(teacher => teacher.name || teacher.id).join('、'), priority: 'hard', status: 'effective' };
            }

            if (row.type === 'subject_not_same_day') {
                const subjects = resolveEntityList(project.subjects || [], row.subjectIds || []);
                const classes = resolveEntityList(project.classes || [], row.classIds || []);
                if (subjects.length < 2) {
                    const reason = '课程不同天至少需要两门可匹配课程，请复核。';
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'global', warnings: [...row.warnings, reason] };
                }
                addSubjectNotSameDay(rules, subjects.map(subject => subject.id), classes.map(klass => klass.id));
                return { ...row, subjectIds: subjects.map(subject => subject.id), classIds: classes.map(klass => klass.id), targetType: 'global', targetId: subjects.map(subject => subject.id).join('|'), targetName: subjects.map(subject => subject.name || subject.id).join('、'), priority: 'hard', status: 'effective' };
            }

            if (row.type === 'subject_sequence') {
                const [before] = resolveEntityList(project.subjects || [], [row.beforeSubjectId || row.beforeSubjectName || row.subjectIds?.[0]]);
                const [after] = resolveEntityList(project.subjects || [], [row.afterSubjectId || row.afterSubjectName || row.subjectIds?.[1]]);
                const classes = resolveEntityList(project.classes || [], row.classIds || []);
                if (!before || !after || before.id === after.id) {
                    const reason = '课程顺序需要两门不同的可匹配课程，请复核。';
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'global', warnings: [...row.warnings, reason] };
                }
                addSubjectSequence(rules, { beforeSubjectId: before.id, afterSubjectId: after.id, classIds: classes.map(klass => klass.id), weight: row.weight || 1 });
                return { ...row, beforeSubjectId: before.id, afterSubjectId: after.id, classIds: classes.map(klass => klass.id), targetType: 'global', targetId: `${before.id}>${after.id}`, targetName: `${before.name || before.id} 先于 ${after.name || after.id}`, priority: 'soft', status: 'effective' };
            }

            return { ...row, status: 'unsupported' };
        });
    rows = stabilizeParsedRows(rows, source);
    unsupportedItems = rows
        .filter(row => row.status === 'suggestion' || row.status === 'unsupported')
        .map(previewFromRow);

    rows = linkRowsToSemanticRequirements(rows, semanticRequirements, project);

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
                '- global_unavailable：全校在某些时间不排常规课。需 slots。priority=hard。',
                '- subject_morning：某课程优先排在上午。需 targetId/target（课程）。priority=soft。',
                '- subject_afternoon：某课程优先排在下午。需 targetId/target（课程）。priority=soft。',
                '- subject_preferred_periods：某课程偏好某些节次。需课程 + slots/periods。priority=soft。',
                '- subject_avoid_periods：某课程避开某些节次。需课程 + slots/periods。priority=soft。',
                '- subject_daily_limit：某课程同一班每天最多几节。需课程 + limit。priority=hard。',
                '- teacher_daily_limit：某教师每天最多上几节。需教师 + limit（整数）。priority=soft。',
                '- teacher_consecutive_limit：某教师最多连续上几节。需教师 + limit（整数）。priority=soft。',
                '- teacher_weekly_limit：某教师每周最多上几节。需教师 + limit。priority=hard。',
                '- teacher_max_days_per_week：某教师每周最多上几天。需教师 + limit。priority=hard。',
                '- teacher_mutual_exclusion：多位教师不能同节上课。需 teacherIds/teachers 至少两个。priority=hard。',
                '- subject_spread：某课程一周内要分散，不要同一天扎堆。需课程。priority=soft。',
                '- course_interval：某课程两次课之间至少间隔几天。需课程 + minGapDays。priority=soft。',
                '- room_requirement：某课程必须使用指定教室/场地。需课程 + roomIds/roomName/requiredTags。priority=hard。',
                '- class_daily_balance：班级每日课时尽量均衡。priority=soft。',
                '- teacher_gap_preference：教师尽量少空堂。priority=soft。',
                '- teacher_load_balance：教师工作量尽量均衡。priority=soft。',
                '- subject_not_same_day：两门课程不能排同一天。需 subjectIds 至少两个，可带 classIds。priority=hard。',
                '- subject_sequence：同一天课程前后顺序。需 beforeSubjectId + afterSubjectId。priority=soft。',
                '',
                '【仅建议类型】（暂不写入排课，仅供复核展示）：block_protection, class_subject_spread, quality_subject_later。无法确定或属于通用常识时，写进 warnings 或 needs_review，不要编造硬约束。',
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
    const seed = Number.parseInt(env.TIMETABLE_RULE_AI_SEED, 10);
    const response = await fetchClient(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            temperature: 0,
            ...(Number.isInteger(seed) ? { seed } : {}),
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

function compactProjectDictionary(project = {}) {
    return {
        teachers: (project.teachers || []).map(({ id, name }) => ({ id, name })),
        classes: (project.classes || []).map(item => ({ id: item.id, name: entityLabel(item) })),
        subjects: (project.subjects || []).map(({ id, name }) => ({ id, name })),
        lessonPlans: (project.lessonPlans || []).map(plan => ({
            id: plan.id,
            classId: plan.classId,
            subjectId: plan.subjectId,
            teacherId: plan.teacherId,
            teacherIds: plan.teacherIds || [],
            weeklyHours: plan.weeklyHours,
            blockPreference: plan.blockPreference || '',
        })),
        activeWeekdays: project.activeWeekdays,
        activePeriods: project.activePeriods,
        timetableModelVersion: project.timetableModelVersion || 'legacy',
        complexModelEnabled: complexModelIsEnabled(project),
    };
}

function compactParseResultForReview(result = {}) {
    return {
        inputType: result.inputType,
        source: result.source,
        parseSource: result.parseSource,
        draftRows: (result.draftRows || []).map(row => ({
            id: row.id,
            stableKey: row.stableKey,
            sourceSheet: row.sourceSheet,
            sourceRow: row.sourceRow,
            rawText: row.rawText,
            type: row.type,
            targetType: row.targetType,
            targetId: row.targetId,
            targetName: row.targetName,
            slots: row.slots,
            days: row.days,
            periods: row.periods,
            priority: row.priority,
            status: row.status,
            confidence: row.confidence,
            warnings: row.warnings || [],
        })),
        requirementItems: (result.requirementItems || []).map(item => ({
            id: item.id,
            object: item.object,
            intent: item.intent,
            parameters: item.parameters,
            strength: item.strength,
            status: item.status,
            applyTo: item.applyTo,
            confidence: item.confidence,
            source: item.source,
            warnings: item.warnings || [],
        })),
        semanticActions: (result.semanticActions || []).map(action => ({
            id: action.id,
            requirementId: action.requirementId,
            kind: action.kind,
            status: action.status,
            target: action.target || {},
            patch: action.patch || {},
        })),
    };
}

function buildAiReviewPrompt({ project, text, inputType, contextStats = null, constraintRows = [], localResult = {} }) {
    return [
        {
            role: 'system',
            content: [
                '你是中文中小学排课需求识别结果的复审核查员。你只复审本地解析结果，不直接生成最终规则。',
                '只输出 JSON 对象，不要 markdown，不要解释文字。格式：{"reviewItems":[],"warnings":[]}。',
                'reviewItems 每项必须包含 verdict、target、reason、evidence，可选 patch 或 suggestedRequirement。',
                'verdict 只能是 accept、flag、suggest_patch、missed_requirement、unsupported。',
                'target 用于定位本地结果，可包含 rowId、requirementId、stableKey、sourceSheet、sourceRow、targetId、type。',
                'evidence 必须包含 quote 或 sourceRow，说明建议来自哪句原文或哪一行 xlsx。',
                'suggest_patch 只能提出字段级建议，系统会重新做本地实体匹配、时间校验和能力校验；不要假设建议会自动生效。',
                'missed_requirement 只能指出漏识别的自然语言需求，不能直接写入项目。',
                '系统基础规则如“同一位教师同一时间只能给一个班上课”“同一班级同一时间只能一门课”属于已处理系统不变量，不要建议生成全教师/全班级不可排。',
                '“默认单节”“连堂块不能拆开”属于系统策略或任课计划策略，不要建议生成无意义的 teacher_unavailable/class_unavailable。',
                '“高负载教师不要连续太多”缺少阈值时应 flag 或 missed_requirement 并要求确认阈值，不要猜成固定 3 节。',
                '具体节次优先于宽泛时段；例如“上午第1-3节”应核查为具体 slots，而不是只保留 subject_morning。',
                '对象或时间不唯一时必须 flag，不能猜。',
            ].join('\n'),
        },
        {
            role: 'user',
            content: JSON.stringify({
                aiReviewPromptVersion: AI_REVIEW_PROMPT_VERSION,
                inputType,
                request: text,
                contextStats,
                constraintRows,
                project: compactProjectDictionary(project),
                supportedCapabilities: {
                    ruleTypes: [...SUPPORTED_EFFECTIVE_TYPES],
                    suggestionTypes: [...SUGGESTION_ONLY_TYPES],
                    semanticDestinations: ['rule', 'lesson_plan', 'optimization', 'solver_policy', 'model_extension', 'review'],
                    complexModelEnabled: complexModelIsEnabled(project),
                },
                localResult: compactParseResultForReview(localResult),
            }),
        },
    ];
}

function normalizeAiReviewContent(content) {
    const parsed = normalizeAiContent(content);
    const items = Array.isArray(parsed.reviewItems)
        ? parsed.reviewItems
        : Array.isArray(parsed.items)
            ? parsed.items
            : Array.isArray(parsed.reviews)
                ? parsed.reviews
                : [];
    return {
        reviewItems: items,
        warnings: warningMessagesFromAi(parsed.warnings || parsed.messages || []),
    };
}

function aiReviewTimeoutError() {
    return new TimetableRuleParseError('AI 复审超时。', 'ai_review_timeout', 504);
}

async function fetchAiReviewWithTimeout(fetchClient, url, options = {}, timeoutMs = DEFAULT_AI_REVIEW_TIMEOUT_MS) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        return fetchClient(url, options);
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timeoutId = null;
    const requestOptions = controller ? { ...options, signal: controller.signal } : options;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            try {
                controller?.abort();
            } catch {
                // Abort is best-effort; the timeout rejection below is authoritative.
            }
            reject(aiReviewTimeoutError());
        }, timeoutMs);
    });

    try {
        return await Promise.race([
            fetchClient(url, requestOptions),
            timeoutPromise,
        ]);
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw aiReviewTimeoutError();
        }
        throw error;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

async function callAiReview({ project, text, inputType, contextStats, constraintRows, localResult, env, fetchImpl }) {
    const { apiKey, baseUrl, model } = resolveAiConfig(env);
    const fetchClient = resolveFetch(fetchImpl);
    const seed = Number.parseInt(env.TIMETABLE_RULE_AI_SEED, 10);
    const response = await fetchAiReviewWithTimeout(fetchClient, `${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            temperature: 0,
            ...(Number.isInteger(seed) ? { seed } : {}),
            response_format: { type: 'json_object' },
            messages: buildAiReviewPrompt({ project, text, inputType, contextStats, constraintRows, localResult }),
        }),
    }, aiReviewTimeoutMs(env));
    const raw = await response.text();
    let payload = {};
    try {
        payload = raw ? JSON.parse(raw) : {};
    } catch {
        throw new TimetableRuleParseError('AI 复审返回内容不是有效 JSON。', 'ai_review_invalid_json', 502);
    }
    if (!response.ok) {
        throw new TimetableRuleParseError(payload.error?.message || 'AI 复审失败。', 'ai_review_failed', response.status || 502);
    }

    const content = payload.choices?.[0]?.message?.content ?? payload;
    try {
        return { ...normalizeAiReviewContent(content), model };
    } catch {
        throw new TimetableRuleParseError('AI 复审结果不是有效 JSON。', 'ai_review_invalid_json', 502);
    }
}

function rowsFromAiConstraints(constraints = [], { inputRows = [], source = 'ai' } = {}) {
    return constraints.map((constraint, index) => {
        const inputRow = inputRows[index] || {};
        const type = normalizeConstraintType(constraint.type || constraint.ruleType);
        const idList = values => [...new Set((Array.isArray(values) ? values : [values])
            .map(value => asText(value, 120))
            .filter(Boolean))];
        return {
            id: asText(constraint.id || inputRow.id, 80) || `rule_draft_${index + 1}`,
            parseSource: source,
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
            teacherIds: idList(constraint.teacherIds || constraint.teachers || []),
            subjectIds: idList(constraint.subjectIds || constraint.subjects || []),
            classIds: idList(constraint.classIds || constraint.classes || []),
            roomIds: idList(constraint.roomIds || constraint.allowedRoomIds || constraint.rooms || []),
            roomName: constraint.roomName || constraint.room || '',
            requiredTags: idList(constraint.requiredTags || constraint.roomTags || []),
            beforeSubjectId: constraint.beforeSubjectId || constraint.before || '',
            afterSubjectId: constraint.afterSubjectId || constraint.after || constraint.nextSubjectId || '',
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
            minGapDays: constraint.minGapDays ?? constraint.gapDays,
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

function textRoomTargets(sentence = '', project = {}) {
    const targets = [];
    (project.rooms || []).forEach(room => {
        if ((room.name && sentence.includes(room.name)) || (room.id && sentence.includes(room.id))) {
            targets.push({ id: room.id, name: room.name || room.id });
        }
    });
    for (const match of sentence.matchAll(/(操场|体育馆|实验室|机房|音乐室|美术室|功能室|[\u4e00-\u9fa5A-Za-z0-9_-]{1,12}(?:教室|场地|室|馆))/g)) {
        targets.push({ id: '', name: match[1] });
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
            const roomTargets = textRoomTargets(sentence, project);
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

            if (slots.length && hasUnavailable && /(全校|全部|所有|统一|升旗|早读|午休|大课间|广播操|全体)/.test(sentence) && !effectiveTeacherTargets.length && !effectiveClassTargets.length) {
                constraints.push(withSource({
                    type: 'global_unavailable',
                    target: '全校',
                    slots,
                    priority: 'hard',
                    reason: rawText,
                    confidence: 0.86,
                    weekPattern,
                }, sourceMeta));
            }

            if (effectiveTeacherTargets.length >= 2 && /(不能|不可|不要).*(同时|同一节|同节)|互斥|错开/.test(sentence)) {
                constraints.push(withSource({
                    type: 'teacher_mutual_exclusion',
                    teacherIds: effectiveTeacherTargets.map(teacher => teacher.id || teacher.name),
                    target: effectiveTeacherTargets.map(teacher => teacher.name).join('、'),
                    priority: 'hard',
                    reason: rawText,
                    confidence: 0.88,
                    weekPattern,
                }, sourceMeta));
            }

            if (effectiveSubjectTargets.length >= 2 && /(不要|不能|不可).*(同一天|同日)|不同天|错开/.test(sentence)) {
                constraints.push(withSource({
                    type: 'subject_not_same_day',
                    subjectIds: effectiveSubjectTargets.map(subject => subject.id || subject.name),
                    classIds: effectiveClassTargets.map(klass => klass.id || klass.name),
                    target: effectiveSubjectTargets.map(subject => subject.name).join('、'),
                    priority: 'hard',
                    reason: rawText,
                    confidence: 0.88,
                    weekPattern,
                }, sourceMeta));
            }

            if (effectiveSubjectTargets.length >= 2 && /(先.*后|先.*再|之后|后再|顺序)/.test(sentence)) {
                const [before, after] = effectiveSubjectTargets;
                constraints.push(withSource({
                    type: 'subject_sequence',
                    beforeSubjectId: before.id || before.name,
                    afterSubjectId: after.id || after.name,
                    subjectIds: [before.id || before.name, after.id || after.name],
                    classIds: effectiveClassTargets.map(klass => klass.id || klass.name),
                    priority: 'soft',
                    reason: rawText,
                    confidence: 0.86,
                    weekPattern,
                }, sourceMeta));
            }

            if (/班级.*(每天|每日).*(均衡|平衡)|班级.*(均衡|平衡).*(每天|每日)/.test(sentence)) {
                const maxMatch = sentence.match(new RegExp(`主科.*?(?:最多|不超过|上限)\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`));
                constraints.push(withSource({
                    type: 'class_daily_balance',
                    target: '全部班级',
                    limit: maxMatch ? parseLooseNumber(maxMatch[1]) : undefined,
                    priority: 'soft',
                    reason: rawText,
                    confidence: 0.86,
                    weekPattern,
                }, sourceMeta));
            }

            if (/教师.*(均衡|平衡|公平)|负载.*(均衡|平衡|公平)/.test(sentence)) {
                constraints.push(withSource({
                    type: 'teacher_load_balance',
                    target: '全部教师',
                    priority: 'soft',
                    reason: rawText,
                    confidence: 0.86,
                    weekPattern,
                }, sourceMeta));
            }

            if (/少空堂|别有空堂|不要.*空堂|空堂.*少|课.*连着上/.test(sentence)) {
                constraints.push(withSource({
                    type: 'teacher_gap_preference',
                    target: '全部教师',
                    priority: 'soft',
                    reason: rawText,
                    confidence: 0.86,
                    weekPattern,
                }, sourceMeta));
            }

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
                const weeklyMatch = sentence.match(new RegExp(`每周.*?(?:最多|不超过|不多于|上限)\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`));
                if (weeklyMatch) {
                    constraints.push(withSource({
                    type: 'teacher_weekly_limit',
                    targetId: teacher.id,
                    target: teacher.name,
                    limit: parseLooseNumber(weeklyMatch[1]),
                    priority: 'hard',
                    reason: rawText,
                    confidence: teacher.id ? 0.88 : 0.7,
                    weekPattern,
                    }, sourceMeta));
                }
                const maxDaysMatch = sentence.match(new RegExp(`每周.*?(?:最多|不超过|不多于|上限)\\s*(${NUMBER_TOKEN_PATTERN})\\s*[天日]`));
                if (maxDaysMatch) {
                    constraints.push(withSource({
                    type: 'teacher_max_days_per_week',
                    targetId: teacher.id,
                    target: teacher.name,
                    limit: parseLooseNumber(maxDaysMatch[1]),
                    priority: 'hard',
                    reason: rawText,
                    confidence: teacher.id ? 0.88 : 0.7,
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
                } else if (/(下午|午后)/.test(sentence) && hasPrefer) {
                    constraints.push(withSource({
                    type: 'subject_afternoon',
                    targetId: subject.id,
                    target: subject.name,
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.86 : 0.68,
                    weekPattern,
                    }, sourceMeta));
                }
                const subjectDailyMatch = sentence.match(new RegExp(`(?:每天|每日).*?(?:最多|不超过|不多于|上限)\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`));
                if (subjectDailyMatch && !/教师|老师/.test(sentence)) {
                    constraints.push(withSource({
                    type: 'subject_daily_limit',
                    targetId: subject.id,
                    target: subject.name,
                    limit: parseLooseNumber(subjectDailyMatch[1]),
                    priority: 'hard',
                    reason: rawText,
                    confidence: subject.id ? 0.88 : 0.68,
                    weekPattern,
                    }, sourceMeta));
                }
                const intervalMatch = sentence.match(new RegExp(`(?:间隔|隔开|至少间隔).*?(${NUMBER_TOKEN_PATTERN})\\s*天|(${NUMBER_TOKEN_PATTERN})\\s*天.*?(?:间隔|隔开)`));
                if (intervalMatch) {
                    constraints.push(withSource({
                    type: 'course_interval',
                    targetId: subject.id,
                    target: subject.name,
                    minGapDays: parseLooseNumber(intervalMatch[1] || intervalMatch[2]),
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.86 : 0.64,
                    weekPattern,
                    }, sourceMeta));
                }
                if (roomTargets.length && /(教室|场地|实验室|机房|操场|体育馆|音乐室|美术室|功能室|安排|使用|去|在)/.test(sentence)) {
                    constraints.push(withSource({
                    type: 'room_requirement',
                    targetId: subject.id,
                    target: subject.name,
                    roomIds: roomTargets.map(room => room.id || room.name),
                    roomName: roomTargets[0]?.name || '',
                    requiredTags: roomTagsFromText(roomTargets[0]?.name || '', sentence),
                    priority: 'hard',
                    reason: rawText,
                    confidence: subject.id ? 0.88 : 0.64,
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

function structuredConstraintFromRow(project, row = {}) {
    const type = normalizeConstraintType(row.ruleType || row.type || '');
    if (!SUPPORTED_EFFECTIVE_TYPES.has(type) && !SUGGESTION_ONLY_TYPES.has(type)) return null;

    const targetType = targetTypeFor(type, row);
    const target = asText(row.target || row.targetName || row.teacherName || row.className || row.subjectName || '', 200);
    const rawText = asText(row.constraintText || row.description || row.ruleName || '', 1500)
        || [
            row.ruleName ? `名称：${row.ruleName}` : '',
            row.ruleType ? `类型：${row.ruleType}` : '',
            target ? `对象：${target}` : '',
            row.days ? `周几：${row.days}` : '',
            row.periods ? `节次：${row.periods}` : '',
            row.slots ? `时间：${row.slots}` : '',
        ].filter(Boolean).join('；');
    const base = {
        type,
        target,
        targetName: target,
        targetType,
        slots: normalizeSlotList(row.slots || row.timeSlots || ''),
        days: row.days || row.weekdays || '',
        periods: row.periods || row.lessonIndexes || '',
        priority: row.priority || row.strength,
        weight: row.weight,
        limit: row.limit || row.value || row.max,
        minGapDays: row.minGapDays || row.gapDays,
        teacherIds: Array.isArray(row.teacherIds) ? row.teacherIds : [],
        subjectIds: Array.isArray(row.subjectIds) ? row.subjectIds : [],
        classIds: Array.isArray(row.classIds) ? row.classIds : [],
        roomIds: Array.isArray(row.roomIds || row.allowedRoomIds) ? (row.roomIds || row.allowedRoomIds) : [],
        roomName: row.roomName || row.room || '',
        requiredTags: Array.isArray(row.requiredTags || row.roomTags) ? (row.requiredTags || row.roomTags) : [],
        beforeSubjectId: row.beforeSubjectId || row.before || '',
        afterSubjectId: row.afterSubjectId || row.after || '',
        reason: row.description || rawText,
        confidence: 0.95,
        sourceSheet: row.sourceSheet,
        sourceRow: row.sourceRow,
    };

    if (targetType === 'teacher') {
        base.teacherId = row.teacherId || row.targetId || '';
        base.teacher = row.teacherName || target;
    } else if (targetType === 'class') {
        base.classId = row.classId || row.targetId || '';
        base.class = row.className || target;
    } else if (targetType === 'subject') {
        base.subjectId = row.subjectId || row.targetId || '';
        base.subject = row.subjectName || target;
    }

    if (!base.slots.length && (base.days || base.periods)) {
        base.slots = slotsFromConstraint(base, project);
    }
    if (row.weekPattern) base.weekPattern = row.weekPattern;
    if (rawText) base.rawText = rawText;

    return base;
}

function localTextConstraintsFromInput(project, text, constraintRows = [], options = {}) {
    if (Array.isArray(constraintRows) && constraintRows.length) {
        return constraintRows.flatMap(row => {
            if (options.preferStructuredRows) {
                const structured = structuredConstraintFromRow(project, row);
                if (structured) return [structured];
            }
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
    const localSource = localParseSourceForInput(inputType);
    const constraints = localTextConstraintsFromInput(project, text, constraintRows, {
        preferStructuredRows: inputType === 'xlsx_constraints',
    });
    if (!constraints.length) {
        const semanticOnly = normalizeTimetableRuleDraftRows({
            project,
            draftRows: [],
            source: localSource,
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
        draftRows: rowsFromAiConstraints(constraints, { inputRows: constraintRows, source: localSource }),
        source: localSource,
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
    return ['text', 'txt', 'csv_text', 'xlsx_constraints'].includes(inputType);
}

function shouldUseAiExtraction(inputType = '', env = {}) {
    if (!['text', 'txt', 'csv_text'].includes(inputType)) return false;
    return ['1', 'true', 'yes', 'on'].includes(String(env.TIMETABLE_RULE_AI_EXTRACT || '').trim().toLowerCase());
}

function localParseSourceForInput(inputType = '') {
    return inputType === 'xlsx_constraints' ? 'local_xlsx' : 'local_text';
}

function localResultIsDecisive(result = {}) {
    const rows = result.draftRows || [];
    if (!rows.length) return false;
    return rows.some(row => row.status === 'effective' || row.weekPattern);
}

function localResultCanSkipAi(text = '', result = {}, inputType = '', constraintRows = []) {
    if (inputType === 'xlsx_constraints') {
        const rows = result.draftRows || [];
        const resolvedRows = new Set(
            rows
                .filter(row => ['effective', 'suggestion', 'ignored'].includes(row.status))
                .map(row => row.sourceRow)
                .filter(value => value !== undefined && value !== null && value !== '')
                .map(String)
        );
        const totalSourceRows = new Set(
            (Array.isArray(constraintRows) ? constraintRows : [])
                .map(row => row.sourceRow)
                .filter(value => value !== undefined && value !== null && value !== '')
                .map(String)
        );
        return Boolean(rows.length)
            && (!totalSourceRows.size || [...totalSourceRows].every(row => resolvedRows.has(row)))
            && rows.every(row => ['effective', 'suggestion', 'ignored'].includes(row.status))
            && rows.some(row => row.status === 'effective');
    }
    if (/[A-Za-z]/.test(text)) return false;
    return localResultIsDecisive(result);
}

function unresolvedConstraintRowsForAi(constraintRows = [], localResult = {}) {
    const resolvedRows = new Set(
        (localResult.draftRows || [])
            .filter(row => ['effective', 'suggestion', 'ignored'].includes(row.status))
            .map(row => row.sourceRow)
            .filter(value => value !== undefined && value !== null && value !== '')
            .map(String)
    );
    return (Array.isArray(constraintRows) ? constraintRows : [])
        .filter(row => !resolvedRows.has(String(row.sourceRow || '')));
}

function normalizeReviewVerdict(value = '') {
    const key = asText(value || '', 80).toLowerCase().replace(/[-\s]+/g, '_');
    return {
        accepted: 'accept',
        ok: 'accept',
        pass: 'accept',
        warning: 'flag',
        needs_review: 'flag',
        review: 'flag',
        patch: 'suggest_patch',
        suggestion: 'suggest_patch',
        missed: 'missed_requirement',
        missing: 'missed_requirement',
        unsupported_item: 'unsupported',
    }[key] || (['accept', 'flag', 'suggest_patch', 'missed_requirement', 'unsupported'].includes(key) ? key : 'flag');
}

function normalizeReviewEvidence(item = {}, target = {}) {
    const evidence = item.evidence && typeof item.evidence === 'object' ? item.evidence : {};
    return {
        quote: asText(evidence.quote || evidence.text || item.quote || item.rawText || '', 500),
        reason: asText(evidence.reason || item.reason || item.message || item.suggestion || '', 500),
        sourceSheet: asText(evidence.sourceSheet || target.sourceSheet || item.sourceSheet || '', 120),
        sourceRow: Number.parseInt(evidence.sourceRow ?? target.sourceRow ?? item.sourceRow, 10) || null,
    };
}

function normalizeAiReviewItems(items = []) {
    return (Array.isArray(items) ? items : []).map((item, index) => {
        const target = item.target && typeof item.target === 'object' ? item.target : {};
        const verdict = normalizeReviewVerdict(item.verdict || item.status || item.action || item.type);
        const reason = asText(item.reason || item.message || item.suggestion || '', 500);
        return {
            id: asText(item.id, 120) || `review_${index + 1}`,
            verdict,
            target: {
                rowId: asText(target.rowId || target.draftRowId || item.rowId || '', 120),
                requirementId: asText(target.requirementId || item.requirementId || '', 120),
                stableKey: asText(target.stableKey || item.stableKey || '', 240),
                sourceSheet: asText(target.sourceSheet || item.sourceSheet || '', 120),
                sourceRow: Number.parseInt(target.sourceRow ?? item.sourceRow, 10) || null,
                targetId: asText(target.targetId || item.targetId || '', 120),
                type: normalizeConstraintType(target.type || item.ruleType || item.constraintType || ''),
            },
            reason,
            evidence: normalizeReviewEvidence({ ...item, reason }, target),
            patch: item.patch && typeof item.patch === 'object' ? item.patch : null,
            suggestedRequirement: item.suggestedRequirement && typeof item.suggestedRequirement === 'object'
                ? item.suggestedRequirement
                : null,
        };
    });
}

function appendUniqueText(values = [], next = '') {
    return [...new Set([...(Array.isArray(values) ? values : []), asText(next, 240)].filter(Boolean))];
}

function reviewTargetMatchesRow(row = {}, target = {}) {
    if (target.rowId && row.id === target.rowId) return true;
    if (target.stableKey && row.stableKey === target.stableKey) return true;
    if (target.sourceRow && Number(row.sourceRow) === Number(target.sourceRow)) {
        if (!target.sourceSheet || !row.sourceSheet || target.sourceSheet === row.sourceSheet) return true;
    }
    if (target.targetId && row.targetId === target.targetId) {
        if (!target.type || target.type === row.type) return true;
    }
    if (target.type && target.type === row.type && !target.rowId && !target.sourceRow && !target.targetId) return true;
    return false;
}

function reviewTargetMatchesRequirement(item = {}, target = {}) {
    if (target.requirementId && item.id === target.requirementId) return true;
    if (target.sourceRow && Number(item.source?.sourceRow) === Number(target.sourceRow)) {
        if (!target.sourceSheet || !item.source?.sourceSheet || target.sourceSheet === item.source.sourceSheet) return true;
    }
    if (target.targetId && (item.object?.matchedIds || []).includes(target.targetId)) return true;
    return false;
}

function markRowWithAiReview(row = {}, status = 'accepted', reviewItem = {}, warning = '') {
    const parseSource = row.parseSource || row.source || 'local';
    return {
        ...row,
        aiReviewStatus: status,
        aiReviewWarnings: warning ? appendUniqueText(row.aiReviewWarnings || [], warning) : row.aiReviewWarnings || [],
        reviewEvidence: reviewItem.evidence || row.reviewEvidence || null,
        reviewedParseSource: `${parseSource}_ai_reviewed`,
        warnings: warning ? appendUniqueText(row.warnings || [], warning) : row.warnings || [],
    };
}

function markRequirementWithAiReview(item = {}, status = 'accepted', reviewItem = {}, warning = '') {
    return {
        ...item,
        aiReviewStatus: status,
        aiReviewWarnings: warning ? appendUniqueText(item.aiReviewWarnings || [], warning) : item.aiReviewWarnings || [],
        reviewEvidence: reviewItem.evidence || item.reviewEvidence || null,
        reviewedParseSource: `${item.source?.parseSource || item.parseSource || 'local'}_ai_reviewed`,
        warnings: warning ? appendUniqueText(item.warnings || [], warning) : item.warnings || [],
    };
}

function sanitizedReviewPatch(patch = {}) {
    const allowed = [
        'type', 'ruleType', 'targetType', 'targetId', 'targetName',
        'teacherId', 'teacherName', 'teacher',
        'classId', 'className', 'class',
        'subjectId', 'subjectName', 'subject',
        'slots', 'days', 'periods', 'priority', 'status',
        'confidence', 'weekPattern', 'limit', 'weight',
        'rawText', 'description', 'reason',
    ];
    return Object.fromEntries(allowed
        .filter(key => Object.prototype.hasOwnProperty.call(patch, key))
        .map(key => [key, patch[key]]));
}

function validatedReviewPatchRow(project = {}, row = {}, patch = {}, { inputType = '', contextStats = null, originalText = '' } = {}) {
    const candidate = {
        ...row,
        ...sanitizedReviewPatch(patch),
        id: row.id,
        stableKey: row.stableKey,
        sourceSheet: row.sourceSheet,
        sourceRow: row.sourceRow,
        parseSource: row.parseSource,
        source: row.source,
        warnings: [],
        ambiguity: null,
        ambiguities: [],
    };
    const normalized = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [candidate],
        source: candidate.parseSource || row.parseSource || 'ai_review',
        inputType,
        contextStats,
        originalText,
    });
    const [validated] = normalized.draftRows || [];
    if (!validated || (normalized.draftRows || []).length !== 1) return null;
    if (['needs_review', 'invalid', 'unsupported'].includes(validated.status)) return null;
    if ((validated.warnings || []).length || validated.ambiguity || (validated.ambiguities || []).length) return null;
    if (['teacher', 'class', 'subject'].includes(validated.targetType) && !validated.targetId) return null;
    if (rowNeedsSlots(validated.type) && !(validated.slots || []).length) return null;
    return validated;
}

function missedRequirementFromReviewItem(reviewItem = {}, index = 0) {
    const suggested = reviewItem.suggestedRequirement || {};
    return {
        id: asText(suggested.id, 120) || `req_ai_review_missed_${index + 1}`,
        object: suggested.object || { kind: 'global', name: asText(suggested.targetName || suggested.target || '待确认需求', 120), matchedIds: [], scope: 'unknown' },
        intent: normalizeRequirementIntentAlias(suggested.intent || suggested.type || 'unknown'),
        condition: suggested.condition || {},
        parameters: suggested.parameters || {},
        strength: asText(suggested.strength || suggested.priority || 'soft', 40),
        status: 'needs_review',
        applyTo: normalizeRequirementApplyToAlias(suggested.applyTo || 'review'),
        confidence: Number.isFinite(Number(suggested.confidence)) ? Number(suggested.confidence) : 0.55,
        source: suggested.source || {
            rawText: reviewItem.evidence?.quote || reviewItem.reason,
            sourceSheet: reviewItem.evidence?.sourceSheet || '',
            sourceRow: reviewItem.evidence?.sourceRow || null,
        },
        warnings: [reviewItem.reason || 'AI 复审发现可能漏识别的需求，请人工确认。'],
        aiReviewStatus: 'missed',
        aiReviewWarnings: [reviewItem.reason || 'AI 复审发现可能漏识别的需求，请人工确认。'],
        reviewEvidence: reviewItem.evidence || null,
    };
}

function applyAiReviewToParseResult({
    project,
    result,
    review,
    text = '',
    inputType = '',
    contextStats = null,
}) {
    const reviewItems = normalizeAiReviewItems(review.reviewItems || []);
    let rows = cloneValue(result.draftRows || []);
    let requirements = cloneValue(result.requirementItems || []);
    const warnings = [...(result.warnings || []), ...(review.warnings || [])];
    const missedRequirements = [];
    let appliedSuggestionCount = 0;
    let flaggedCount = 0;

    reviewItems.forEach((item, index) => {
        const rowIndexes = rows
            .map((row, rowIndex) => reviewTargetMatchesRow(row, item.target) ? rowIndex : -1)
            .filter(rowIndex => rowIndex >= 0);
        const requirementIndexes = requirements
            .map((requirement, requirementIndex) => reviewTargetMatchesRequirement(requirement, item.target) ? requirementIndex : -1)
            .filter(requirementIndex => requirementIndex >= 0);
        const reason = item.reason || 'AI 复审提示需要人工确认。';

        if (item.verdict === 'accept') {
            rowIndexes.forEach(rowIndex => {
                rows[rowIndex] = markRowWithAiReview(rows[rowIndex], 'accepted', item);
            });
            requirementIndexes.forEach(requirementIndex => {
                requirements[requirementIndex] = markRequirementWithAiReview(requirements[requirementIndex], 'accepted', item);
            });
            return;
        }

        if (item.verdict === 'flag' || item.verdict === 'unsupported') {
            flaggedCount += Math.max(1, rowIndexes.length || requirementIndexes.length);
            rowIndexes.forEach(rowIndex => {
                const row = rows[rowIndex];
                rows[rowIndex] = {
                    ...markRowWithAiReview(row, item.verdict === 'unsupported' ? 'unsupported' : 'flagged', item, reason),
                    status: row.status === 'ignored' ? row.status : 'needs_review',
                };
            });
            requirementIndexes.forEach(requirementIndex => {
                const requirement = requirements[requirementIndex];
                requirements[requirementIndex] = {
                    ...markRequirementWithAiReview(requirement, item.verdict === 'unsupported' ? 'unsupported' : 'flagged', item, reason),
                    status: requirement.status === 'handled' ? requirement.status : 'needs_review',
                    applyTo: requirement.status === 'handled' ? requirement.applyTo : 'review',
                };
            });
            return;
        }

        if (item.verdict === 'suggest_patch') {
            if (!item.patch || !rowIndexes.length) {
                warnings.push(`AI 复审建议未通过本地校验：${reason}`);
                return;
            }
            rowIndexes.forEach(rowIndex => {
                const patched = validatedReviewPatchRow(project, rows[rowIndex], item.patch, {
                    inputType,
                    contextStats,
                    originalText: text,
                });
                if (!patched) {
                    warnings.push(`AI 复审建议未通过本地校验：${reason}`);
                    rows[rowIndex] = markRowWithAiReview(rows[rowIndex], 'patch_rejected', item, `AI 复审建议未通过本地校验：${reason}`);
                    return;
                }
                rows[rowIndex] = markRowWithAiReview({ ...patched, id: rows[rowIndex].id, stableKey: rows[rowIndex].stableKey }, 'patched', item);
                appliedSuggestionCount += 1;
            });
            return;
        }

        if (item.verdict === 'missed_requirement') {
            flaggedCount += 1;
            missedRequirements.push(missedRequirementFromReviewItem(item, index));
        }
    });

    const rebuilt = normalizeTimetableRuleDraftRows({
        project,
        draftRows: rows,
        source: result.source || result.parseSource || 'ai_review',
        inputType: result.inputType || inputType,
        contextStats: result.contextStats || contextStats,
        originalText: text,
        semanticRequirements: [...requirements, ...missedRequirements],
        initialWarnings: [...new Set(warnings.filter(Boolean))],
    });
    return {
        ...rebuilt,
        aiReview: aiReviewStatusPayload({
            status: 'reviewed',
            model: review.model || '',
            reviewItems,
            warnings,
            appliedSuggestionCount,
            flaggedCount,
        }),
    };
}

async function reviewTimetableParseResult({ project, text, inputType, contextStats = null, constraintRows = [], result, env, fetchImpl }) {
    if (aiReviewDisabled(env)) {
        return withAiReviewUnavailable(result, 'disabled', 'AI 复审已禁用，已返回本地识别结果。');
    }
    if (!hasConfiguredAi(env)) {
        return withAiReviewUnavailable(result, 'ai_not_configured', 'AI 复审不可用，已返回本地识别结果：ai_not_configured');
    }
    try {
        const review = await callAiReview({
            project,
            text,
            inputType,
            contextStats,
            constraintRows,
            localResult: result,
            env,
            fetchImpl,
        });
        return applyAiReviewToParseResult({
            project,
            result,
            review,
            text,
            inputType,
            contextStats,
        });
    } catch (error) {
        const reason = error instanceof TimetableRuleParseError ? error.reason : 'ai_review_failed';
        const message = error?.message || reason;
        return withAiReviewUnavailable(result, reason, `AI 复审未完成，已返回本地识别结果：${message}`);
    }
}

async function parseAiOrLocal({ project, text, inputType, contextStats = null, constraintRows = [], env, fetchImpl }) {
    const aiExtractWarnings = [];
    if (shouldUseAiExtraction(inputType, env)) {
        try {
            const extracted = await extractRequirementsWithAI({
                project,
                text,
                contextStats,
                env,
                fetchImpl,
            });
            const normalized = normalizeTimetableRuleDraftRows({
                project,
                draftRows: extracted.draftRows,
                source: 'ai_extract',
                inputType,
                contextStats: {
                    ...(contextStats || {}),
                    aiExtractModel: extracted.model || '',
                    aiExtractPromptVersion: extracted.promptVersion || '',
                    aiExtractRequirementCount: extracted.rawRequirements?.length || 0,
                },
                originalText: text,
                semanticRequirements: extracted.semanticRequirements,
                initialWarnings: extracted.warnings || [],
            });
            return {
                ...normalized,
                parseSource: 'ai_extract',
                aiReview: aiReviewStatusPayload({
                    status: 'skipped',
                    reason: 'ai_extract',
                    model: extracted.model || '',
                    warnings: [],
                }),
            };
        } catch (error) {
            const reason = error?.reason || 'ai_extract_failed';
            const message = error?.message || reason;
            aiExtractWarnings.push(`AI-first 抽取失败，已降级到本地识别：${message}`);
        }
    }
    let localConstraints = [];
    let localResult = null;
    if (shouldUseLocalFirst(inputType)) {
        const localSource = localParseSourceForInput(inputType);
        localConstraints = localTextConstraintsFromInput(project, text, constraintRows, {
            preferStructuredRows: inputType === 'xlsx_constraints',
        });
        if (localConstraints.length) {
            localResult = normalizeTimetableRuleDraftRows({
                project,
                draftRows: rowsFromAiConstraints(localConstraints, { inputRows: constraintRows, source: localSource }),
                source: localSource,
                inputType,
                contextStats,
                originalText: text,
                initialWarnings: [...aiExtractWarnings, ...(hasConfiguredAi(env) ? [] : ['智能解析不可用，已仅提取明确规则：ai_not_configured'])],
            });
            if (!hasConfiguredAi(env)) {
                return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: localResult, env, fetchImpl });
            }
            if (localResultCanSkipAi(text, localResult, inputType, constraintRows)) {
                return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: localResult, env, fetchImpl });
            }
        } else if (!hasConfiguredAi(env)) {
            const semanticOnly = normalizeTimetableRuleDraftRows({
                project,
                draftRows: [],
                source: localSource,
                inputType,
                contextStats,
                originalText: text,
                initialWarnings: [...aiExtractWarnings, '智能解析不可用，已仅提取明确需求：ai_not_configured'],
            });
            if ((semanticOnly.requirementItems || []).length) {
                return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: semanticOnly, env, fetchImpl });
            }
        }
    }
    try {
        const aiConstraintRows = inputType === 'xlsx_constraints' && localResult
            ? unresolvedConstraintRowsForAi(constraintRows, localResult)
            : constraintRows;
        if (inputType === 'xlsx_constraints' && localResult && !aiConstraintRows.length) {
            return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: localResult, env, fetchImpl });
        }
        const aiText = inputType === 'xlsx_constraints'
            ? textFromConstraintRows(aiConstraintRows) || text
            : text;
        const parsed = await callAi({
            project,
            text: aiText,
            inputType,
            contextStats,
            constraintRows: aiConstraintRows,
            env,
            fetchImpl,
        });
        const constraints = aiDraftRowsFromParsed(parsed);
        const aiSource = inputType === 'xlsx_constraints' ? 'ai_supplement' : 'ai';
        const localSource = localParseSourceForInput(inputType);
        const warnings = [
            ...warningMessagesFromAi(parsed.warnings),
            ...warningMessagesFromAi(parsed.missingInfo),
            ...warningMessagesFromAi(parsed.conflicts),
        ];
        const normalized = normalizeTimetableRuleDraftRows({
            project,
            draftRows: [
                ...(inputType === 'xlsx_constraints' && localConstraints.length
                    ? rowsFromAiConstraints(localConstraints, { inputRows: constraintRows, source: localSource })
                    : []),
                ...rowsFromAiConstraints(constraints, { inputRows: aiConstraintRows, source: aiSource }),
            ],
            source: inputType === 'xlsx_constraints' && localConstraints.length ? 'mixed_xlsx' : aiSource,
            inputType,
            contextStats,
            originalText: text,
            semanticRequirements: parsed.requirementItems || [],
            initialWarnings: [...aiExtractWarnings, ...warnings],
        });
        return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: normalized, env, fetchImpl });
    } catch (error) {
        if (error instanceof TimetableRuleParseError && ['ai_not_configured', 'missing_fetch'].includes(error.reason)) {
            const fallback = parseConstraintsWithLocalFallback({ project, text, inputType, contextStats, constraintRows, error });
            return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: fallback, env, fetchImpl });
        }
        throw error;
    }
}

async function parseRosterWorkbookRules({ file, project, env, fetchImpl }) {
    const preview = previewTimetableRosterFile(file, { project });
    const contextStats = rosterContext(preview);
    const rosterProject = projectWithRosterPreview(project, preview);
    void env;
    void fetchImpl;
    return normalizeRosterFallback({
        project: rosterProject,
        preview,
        contextStats,
    });
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
            const cacheKey = parseCacheKey({ fileBuffer: file.buffer, project, env });
            const cached = getParseCache(cacheKey);
            if (cached) {
                return withParseMetadata(cached, { cacheHit: true, parseSource: 'cache' });
            }
            const sheets = workbookSheets(file);
            const classified = classifyWorkbook(sheets);
            let result;
            if (classified.inputType === 'xlsx_roster') {
                result = await parseRosterWorkbookRules({ file, project, env, fetchImpl });
            } else {
                result = await parseConstraintWorkbookRules({ classified, project, env, fetchImpl });
            }
            const normalizedResult = withParseMetadata(result);
            setParseCache(cacheKey, normalizedResult);
            return normalizedResult;
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
