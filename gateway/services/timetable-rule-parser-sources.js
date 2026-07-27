import AdmZip from 'adm-zip';
import {
    getActivePeriods,
    getDayPartPeriods,
    getActiveWeekdays,
    normalizeTimetableProject,
    slotKey,
} from './timetable-project.js';
import {
    buildTimetableRosterFromRows,
} from './timetable-import.js';
import {
    buildSourceRequirements,
    sourceInputRowsFromText,
} from './timetable-constraints/source-requirement.js';
import {
    alignAiArtifactsToSources,
} from './timetable-constraints/ai-source-alignment.js';

import {
    blockPreferenceFromText,
    complexModelIsEnabled,
    externalRequirementItems,
    gradeNamesFromText,
    rawRowsFromConstraints,
    requirementFromRow,
    roomTagsFromText,
    semanticRequirementMatchesRow,
} from './timetable-rule-parser-artifacts.js';
import {
    CHINESE_NUMBER_TO_VALUE,
    DAY_NAME_TO_NUMBER,
    ENGLISH_DAY_NAME_TO_NUMBER,
    MAX_RULE_FILE_BYTES,
    NUMBER_TOKEN_PATTERN,
    SUGGESTION_ONLY_TYPES,
    SUPPORTED_EFFECTIVE_TYPES,
    SYSTEM_CLASS_TIME_CONFLICT_PATTERN,
    SYSTEM_LESSON_HOURS_COMPLETENESS_PATTERN,
    SYSTEM_TEACHER_TIME_CONFLICT_PATTERN,
} from './timetable-rule-parser-ir.js';
import {
    normalizeTimetableRuleDraftRows,
    parserShadowTextWithTrace,
} from './timetable-rule-parser.js';

class TimetableRuleParseError extends Error {
    constructor(message, reason = 'ai_unavailable', status = 503) {
        super(message);
        this.name = 'TimetableRuleParseError';
        this.reason = reason;
        this.status = status;
    }
}

function asText(value, max = 4000) {
    return String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function cleanRulePromptText(value = '') {
    return String(value ?? '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
        .replace(/\r\n?/g, '\n')
        .trim();
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
    return asList(rows)
        .filter(item => item && typeof item === 'object')
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
    if (['advancedconstraint', 'advanced_constraint'].includes(compact)) return 'advanced_constraint';
    if (['teacherunavailable', '教师不可排', '教师不排', '教师时间不可用', 'teacher_not_available'].includes(compact)) return 'teacher_unavailable';
    if (['classunavailable', '班级不可排', '班级不排', 'class_not_available'].includes(compact)) return 'class_unavailable';
    if (['globalunavailable', '全校不可排', '公共不可排', '全局不可排', 'school_unavailable'].includes(compact)) return 'global_unavailable';
    if (['subjectmorning', '课程上午优先', '主科上午', '上午优先', 'morning_subject', 'subject_prefer_morning'].includes(compact)) return 'subject_morning';
    if (['subjectafternoon', '课程下午优先', '下午优先', 'afternoon_subject', 'subject_prefer_afternoon'].includes(compact)) return 'subject_afternoon';
    if (compact === 'preferred_periods') return 'subject_preferred_periods';
    if (['subjectpreferperiods', 'subjectpreferredperiods', '课程偏好节次', '课程优先节次', 'subject_prefer_periods', 'subject_preferred_slots'].includes(compact)) return 'subject_preferred_periods';
    if (compact === 'avoid_periods') return 'subject_avoid_periods';
    if (['subjectavoidperiods', '课程避开节次', 'subject_avoid_slots'].includes(compact)) return 'subject_avoid_periods';
    if (/课程.*每[天日].*(最多|上限|不超过)|subject.*dail?y?.*(limit|max)/.test(text)) return 'subject_daily_limit';
    if (/教师.*每[天日].*(最多|上限|不超过)|teacher.*dail?y?.*(limit|max)/.test(text)) return 'teacher_daily_limit';
    if (/教师.*(连续|连堂|连排).*(最多|上限|不超过|限制)|teacher.*consecutive/.test(text)) return 'teacher_consecutive_limit';
    // “教师每周最多天数”必须先于宽泛的“教师每周上限”判断，否则会被误识别为周课时上限。
    if (/教师.*(?:每周)?.*(?:最多|上限|不超过).*(?:天数|[天日])|teacher.*max.*days/.test(text)) return 'teacher_max_days_per_week';
    if (/教师.*每周.*(?:最多|上限|不超过).*(?:课时|节)|teacher.*week.*(?:lesson|hour|period)?.*(limit|max)/.test(text)) return 'teacher_weekly_limit';
    if (/教师.*每周.*(最多|上限|不超过)/.test(text)) return 'teacher_weekly_limit';
    if (/教师.*(互斥|不能同时|错开)|mutual.*exclusion/.test(text)) return 'teacher_mutual_exclusion';
    if (/(同科|同一?门?课|同学科).*(分散|不要?连?排?在?同一?天|错开)|subject.*spread/.test(text)) return 'subject_spread';
    if (/课程.*间隔|course.*interval/.test(text)) return 'course_interval';
    // Preserve semantic-only room intents before the broad room matcher below.
    if (['roompreferred', 'room_preferred', 'preferred_room', 'room.preferred'].includes(compact)) return 'room_preferred';
    if (['roomforbiddentype', 'room_forbidden_type', 'forbidden_room_type', 'room.forbidden_type'].includes(compact)) return 'room_forbidden_type';
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

function constraintLimitFromText(type, value = '') {
    const text = asText(value, 1500);
    if (!text) return undefined;
    const token = `(${NUMBER_TOKEN_PATTERN})`;
    const patterns = {
        teacher_daily_limit: [
            `(?:日课量|每日课量|每天课量|单日课量|一天课量)[^，。;；]{0,30}?(?:最多|顶多|上限(?:为|是)?|不超过|不要超过|不多于|至多)\\s*(?:上|排|安排)?\\s*${token}\\s*(?:节|堂|课时)?`,
            `(?:每天|每日|一天|单日)[^，。;；]{0,24}?(?:最多|顶多|上限(?:为|是)?|不超过|不要超过|不多于|至多)\\s*(?:上|排|安排)?\\s*${token}\\s*(?:节|堂|课时)`,
        ],
        teacher_consecutive_limit: [
            `(?:连续|连排|连堂)[^，。;；]{0,24}?(?:最多|上限(?:为|是)?|不超过|不要超过|不多于|至多)\\s*${token}\\s*(?:节|课时)`,
        ],
        teacher_weekly_limit: [
            `(?:周课时|每周课时|一周课时)[^，。;；]{0,24}?(?:有|为|是|最多|上限(?:为|是)?|不超过|不要超过|不多于|至多)?\\s*${token}\\s*(?:节|课时)`,
            `每周[^，。;；]{0,24}?(?:最多|上限(?:为|是)?|不超过|不要超过|不多于|至多)\\s*${token}\\s*(?:节|课时)`,
        ],
        teacher_max_days_per_week: [
            `(?:集中(?:在|到)|控制在|压缩在|安排在)?\\s*每周\\s*${token}\\s*(?:天|日)(?:内|以内)?`,
            `每周[^，。;；]{0,20}?(?:最多|上限(?:为|是)?|不超过|不要超过|不多于|至多)\\s*${token}\\s*(?:天|日)`,
            `(?:这周|本周|一周|每周)[^，。;；]{0,20}?(?:只来|只在|只能来|到校|来校)\\s*${token}\\s*(?:天|日)`,
        ],
        subject_daily_limit: [
            `(?:每天|每日|一天|单日)[^，。;；]{0,24}?(?:最多|上限(?:为|是)?|不超过|不要超过|不多于|至多)\\s*${token}\\s*(?:节|课时)`,
        ],
    };
    for (const pattern of patterns[type] || []) {
        const match = text.match(new RegExp(pattern));
        const parsed = match ? parseLooseNumber(match[1]) : null;
        if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
    return undefined;
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

function hasExplicitDayExpression(text = '') {
    const value = asText(text, 300);
    return /(?:每周|周|星期|礼拜)[一二三四五六日天1-7]|工作日|全周|每天|每日|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(value);
}

function hasExplicitPeriodExpression(text = '') {
    const value = asText(text, 300);
    const rangePattern = new RegExp(`第?\\s*${NUMBER_TOKEN_PATTERN}\\s*[-~到至]\\s*第?\\s*${NUMBER_TOKEN_PATTERN}\\s*节?`);
    const singlePattern = new RegExp(`第\\s*${NUMBER_TOKEN_PATTERN}\\s*节|${NUMBER_TOKEN_PATTERN}\\s*节`);
    const relativeCountPattern = new RegExp(`(?:前|头|开头|最前|后|最后|末|末尾|尾|倒数)\\s*${NUMBER_TOKEN_PATTERN}\\s*节`);
    const relativeIndexPattern = new RegExp(`倒数\\s*第\\s*${NUMBER_TOKEN_PATTERN}\\s*节|(?:末节|尾节|首节|头节)`);
    return rangePattern.test(value)
        || singlePattern.test(value)
        || relativeCountPattern.test(value)
        || relativeIndexPattern.test(value);
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
    const consumedRanges = [];
    if (/全部|全日|all/i.test(text)) return active;

    const consume = match => {
        if (Number.isInteger(match.index)) consumedRanges.push([match.index, match.index + match[0].length]);
    };
    const periodBase = (match, requiredCount = 1) => {
        const part = dayPartName(match[0]);
        const partPeriods = part ? getDayPartPeriods(project, part) : [];
        return partPeriods.length >= requiredCount ? partPeriods : active;
    };

    const reverseIndexPattern = new RegExp(`(?:上午|早上|下午|后半天|晚间|晚上|晚自习|夜自习|morning|afternoon|evening|night)?\\s*倒数\\s*第\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`, 'gi');
    for (const match of text.matchAll(reverseIndexPattern)) {
        const indexFromEnd = parseLooseNumber(match[1]);
        const base = periodBase(match, indexFromEnd);
        if (Number.isInteger(indexFromEnd) && indexFromEnd > 0 && indexFromEnd <= base.length) {
            values.push(base[base.length - indexFromEnd]);
        }
        consume(match);
    }

    const relativeCountPattern = new RegExp(`(?:上午|早上|下午|后半天|晚间|晚上|晚自习|夜自习|morning|afternoon|evening|night)?\\s*(前|头|开头|最前|后|最后|末|末尾|尾|倒数)\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`, 'gi');
    for (const match of text.matchAll(relativeCountPattern)) {
        const count = parseLooseNumber(match[2]);
        if (!Number.isInteger(count) || count <= 0) {
            consume(match);
            continue;
        }
        const base = periodBase(match, count);
        const fromStart = /^(?:前|头|开头|最前)$/.test(match[1]);
        const selected = fromStart ? base.slice(0, count) : base.slice(Math.max(0, base.length - count));
        values.push(...selected);
        consume(match);
    }

    const relativeSinglePattern = /(?:上午|早上|下午|后半天|晚间|晚上|晚自习|夜自习|morning|afternoon|evening|night)?\s*(末节|尾节|首节|头节)/gi;
    for (const match of text.matchAll(relativeSinglePattern)) {
        const base = periodBase(match);
        const fromStart = /(?:首节|头节)/.test(match[1]);
        if (base.length) values.push(fromStart ? base[0] : base[base.length - 1]);
        consume(match);
    }

    const unconsumedText = consumedRanges.length
        ? text.split('').map((char, index) => consumedRanges.some(([start, end]) => index >= start && index < end) ? ' ' : char).join('')
        : text;
    const absoluteText = unconsumedText
        .replace(/\b[A-Za-z]+\d{1,2}-\d{1,2}\s*班?/g, ' ')
        .replace(/\b\d{1,2}-\d{1,2}\s*班/g, ' ');
    const rangePattern = new RegExp(`第?\\s*(${NUMBER_TOKEN_PATTERN})\\s*[-~到至]\\s*第?\\s*(${NUMBER_TOKEN_PATTERN})\\s*节?`, 'g');
    for (const range of absoluteText.matchAll(rangePattern)) {
        values.push(...expandRange(range[1], range[2], maxPeriod));
    }
    const parallelPattern = new RegExp(`第\\s*${NUMBER_TOKEN_PATTERN}(?:\\s*(?:[,，、]|和|及|与)\\s*第?\\s*${NUMBER_TOKEN_PATTERN})+\\s*节`, 'g');
    for (const match of absoluteText.matchAll(parallelPattern)) {
        const tokens = match[0]
            .replace(/\s*节$/, '')
            .replace(/第/g, '')
            .split(/\s*(?:[,，、]|和|及|与)\s*/);
        for (const token of tokens) {
            const period = parseLooseNumber(token);
            if (Number.isInteger(period)) values.push(period);
        }
    }
    const singlePattern = new RegExp(`第?\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`, 'g');
    for (const match of absoluteText.matchAll(singlePattern)) {
        const token = match[1];
        const period = parseLooseNumber(token);
        if (Number.isInteger(period)) {
            values.push(period);
        } else if (/^[一二三四五六七八九]{2,}$/.test(token)) {
            values.push(...[...token].map(parseLooseNumber).filter(Number.isInteger));
        }
    }
    for (const match of absoluteText.matchAll(/\bperiod\s*(\d{1,2})\b/gi)) {
        values.push(Number.parseInt(match[1], 10));
    }
    if (!values.length && /^\d{1,2}$/.test(text)) values.push(Number.parseInt(text, 10));
    if (!values.length && dayPartName(text)) return getDayPartPeriods(project, dayPartName(text));
    return uniqueNumbers(values.length ? values : fallback);
}

function normalizeSlotList(values = []) {
    const source = typeof values === 'string'
        ? String(values || '').split(/[,，;；、\s]+/)
        : asList(values);
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

    const aliasMap = project.constraintEntityAliases?.[targetType] || {};
    const normalizedAliasQuery = normalizeEntityName(query);
    const aliasTargetId = Object.entries(aliasMap).find(([alias]) => (
        normalizeEntityName(alias) === normalizedAliasQuery
    ))?.[1];
    if (aliasTargetId) {
        const aliasTarget = items.find(item => item.id === aliasTargetId);
        if (aliasTarget) {
            const candidate = { ...candidatePreview(aliasTarget, targetType, 1), matchType: 'alias' };
            return { candidates: [candidate], confidence: 1, targetText: query, targetType, matchType: 'alias' };
        }
    }

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
    if (type === 'teacher_gap_preference') {
        const target = asText(row.target || row.targetName || row.teacherName || row.teacher || '', 200);
        if (/(全部|所有|全体|整体).*(教师|老师)|^(全部教师|所有教师|全体教师)$/.test(target)) return 'teacher_group';
        return target ? 'teacher' : 'teacher_group';
    }
    if (type === 'class_unavailable') return 'class';
    if (type === 'locked_slot') return 'locked_slot';
    if (type === 'global_unavailable' || type === 'class_daily_balance' || type === 'teacher_load_balance' || type === 'teacher_mutual_exclusion' || type === 'subject_not_same_day' || type === 'subject_sequence') return 'global';
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

function normalizeAiContent(content) {
    if (typeof content === 'object' && content) return content;
    const text = String(content || '').trim();
    if (!text) return {};
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    return JSON.parse(fenced ? fenced[1] : text);
}

function aiDraftRowsFromParsed(parsed = {}) {
    if (parsed.draftRows !== undefined && parsed.draftRows !== null) return asList(parsed.draftRows);
    const groupedRows = [
        ...asList(parsed.autoAcceptable),
        ...asList(parsed.needReview),
        ...asList(parsed.unsupportedItems),
    ];
    if (groupedRows.length) return groupedRows;
    if (parsed.constraints !== undefined && parsed.constraints !== null) return asList(parsed.constraints);
    if (parsed.rules !== undefined && parsed.rules !== null) return asList(parsed.rules);
    return [];
}

function warningMessagesFromAi(value = []) {
    return normalizedMessageValues(240, value);
}

function buildPrompt({ project, text, inputType = 'text', contextStats = null, constraintRows = [] }) {
    return [
        {
            role: 'system',
            content: [
                '你是中文中小学排课约束候选抽取助手。你只负责从自然语言、TXT、XLSX 内容中抽取候选约束，不负责最终生效判断。',
                '只输出 JSON 对象，不要 markdown，不要解释文字。优先输出完整 Agent schema：{"requirementItems":[],"draftRows":[],"autoAcceptable":[],"needReview":[],"clarifyingQuestions":[],"missingInfo":[],"conflicts":[],"warnings":[],"unsupportedItems":[],"confidenceSummary":{"high":0,"medium":0,"low":0},"nextAction":"review"}。',
                'requirementItems 用于表达“对象是谁 + 需求是什么 + 应该落到哪里”；draftRows 用于兼容旧规则草稿。系统会重新校验和重分组。',
                'Every returned requirementItems[] and draftRows[] item must copy sourceId and textHash from exactly one provided constraintRows[] item.',
                'Never align output to input by array index. If source identity cannot be proven, omit the executable row and add a warning.',
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
                '- subject_morning：某班某课程优先排在上午。需课程 + 班级；可选限定教师。priority=soft。',
                '- subject_afternoon：某课程优先排在下午。需 targetId/target（课程）。priority=soft。',
                '- subject_preferred_periods：某班某课程偏好某些节次。需课程 + 班级 + slots/periods；可选限定教师。priority=soft。',
                '- subject_avoid_periods：某班某课程避开某些节次。需课程 + 班级 + slots/periods；可选限定教师。priority=soft。',
                '- subject_daily_limit：某课程同一班每天最多几节。需课程 + limit。priority=hard。',
                '- teacher_daily_limit：某教师每天最多上几节。需教师 + limit（整数）。priority=soft。',
                '- teacher_consecutive_limit：某教师最多连续上几节。需教师 + limit（整数）。priority=soft。',
                '- teacher_weekly_limit：某教师每周最多上几节。需教师 + limit。priority=hard。',
                '- teacher_max_days_per_week：某教师每周最多上几天。需教师 + limit。priority=hard。',
                '- teacher_mutual_exclusion：多位教师不能同节上课。需 teacherIds/teachers 至少两个。priority=hard。',
                '- subject_spread：某班某课程一周内要分散，不要同一天扎堆。需课程 + 班级；可选限定教师。priority=soft。',
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
                '输入："高一1班数学尽量排上午" → {"type":"subject_morning","target":"数学","class":"高一1班","priority":"soft","reason":"高一1班数学优先上午","confidence":0.9}',
                '输入："李老师必须周三第3节上高一1班数学" → {"type":"locked_slot","teacher":"李老师","class":"高一1班","subject":"数学","slots":["3-3"],"priority":"hard","reason":"固定课节","confidence":0.9}',
                '输入："李老师每天最多上3节课" → {"type":"teacher_daily_limit","target":"李老师","limit":3,"priority":"soft","reason":"控制李老师每日工作量","confidence":0.9}',
                '输入："高一1班体育尽量分散到不同天" → {"type":"subject_spread","target":"体育","class":"高一1班","priority":"soft","reason":"高一1班体育课分散","confidence":0.8}',
                '课程优先/避开/上午优先/分散安排必须给出班级；只有原文明确“全校”时，才能保留全校课程范围。没有班级也没有全校范围时，返回 clarification，不得默认扩大到全校。',
                '输入："高一1班美术第一节不要排" → {"type":"subject_avoid_periods","target":"美术","class":"高一1班","periods":[1],"priority":"soft","reason":"高一1班美术避开第一节","confidence":0.85}',
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
            teacherIds: normalizedTextValues(120, plan.teacherIds, plan.teacherId),
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
            requirementId: row.requirementId,
            clauseId: row.clauseId,
            stableKey: row.stableKey,
            sourceId: row.sourceId,
            textHash: row.textHash,
            origin: row.origin,
            parsedBy: row.parsedBy || [],
            sourceSheet: row.sourceSheet,
            sourceRow: row.sourceRow,
            lineNumber: row.lineNumber,
            rawText: row.rawText,
            capabilityId: row.capabilityId,
            intent: row.intent,
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
            sourceId: item.sourceId || item.source?.sourceId,
            textHash: item.textHash || item.source?.textHash,
            origin: item.origin || item.source?.origin,
            parsedBy: item.parsedBy || item.source?.parsedBy || [],
            sourceSheet: item.sourceSheet || item.source?.sourceSheet,
            sourceRow: item.sourceRow ?? item.source?.sourceRow,
            lineNumber: item.lineNumber ?? item.source?.lineNumber,
            rawText: item.rawText || item.source?.rawText,
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
            sourceId: action.sourceId || action.source?.sourceId,
            textHash: action.textHash || action.source?.textHash,
            origin: action.origin || action.source?.origin,
            parsedBy: action.parsedBy || action.source?.parsedBy || [],
            kind: action.kind,
            status: action.status,
            target: action.target || {},
            patch: action.patch || {},
        })),
    };
}

function hasExplicitAiSourceIdentity(artifact = {}) {
    return Boolean(
        asText(artifact.sourceId || artifact.source?.sourceId || artifact.target?.sourceId || artifact.evidence?.sourceId || '', 300)
        || asText(artifact.textHash || artifact.source?.textHash || artifact.target?.textHash || artifact.evidence?.textHash || '', 128)
        || Number.parseInt(
            artifact.sourceRow
            ?? artifact.rowNumber
            ?? artifact.source?.sourceRow
            ?? artifact.source?.rowNumber
            ?? artifact.target?.sourceRow
            ?? artifact.evidence?.sourceRow,
            10
        ) > 0
        || Number.parseInt(
            artifact.lineNumber
            ?? artifact.source?.lineNumber
            ?? artifact.target?.lineNumber
            ?? artifact.evidence?.lineNumber,
            10
        ) > 0
    );
}

function sourceRequirementById(sourceRequirements = [], sourceId = '') {
    const normalizedId = asText(sourceId, 300);
    if (!normalizedId) return null;
    return asList(sourceRequirements).find(item => item?.sourceId === normalizedId) || null;
}

function attachSourceRequirementToAiConstraint(constraint = {}, sourceRequirement = {}, requirement = null) {
    const source = sourceRequirement.source || {};
    return {
        ...constraint,
        requirementId: constraint.requirementId || requirement?.id || requirement?.requirementId || '',
        clauseId: constraint.clauseId || requirement?.clauseId || '',
        sourceId: sourceRequirement.sourceId || constraint.sourceId || '',
        textHash: source.textHash || sourceRequirement.textHash || constraint.textHash || '',
        origin: sourceRequirement.origin || constraint.origin || 'unknown',
        parsedBy: normalizedParsedBy([
            ...asList(sourceRequirement.parsedBy),
            ...asList(constraint.parsedBy),
        ], 'ai'),
        sourceSheet: source.sheetName || sourceRequirement.sourceSheet || constraint.sourceSheet || '',
        sourceRow: source.rowNumber ?? sourceRequirement.sourceRow ?? constraint.sourceRow ?? null,
        lineNumber: source.lineNumber ?? sourceRequirement.lineNumber ?? constraint.lineNumber ?? null,
        rawText: source.rawText || sourceRequirement.rawText || constraint.rawText || constraint.constraintText || '',
    };
}

function buildLegacyAiSourceEvidence(project = {}, sourceRequirements = []) {
    return asList(sourceRequirements)
        .filter(item => item && typeof item === 'object' && item.sourceId)
        .map(sourceRequirement => {
            const source = sourceRequirement.source || {};
            const rawText = asText(source.rawText || sourceRequirement.rawText || '', 2000);
            if (!rawText) return { sourceRequirement, requirements: [] };
            const sourceMeta = {
                sourceId: sourceRequirement.sourceId,
                textHash: source.textHash || sourceRequirement.textHash || '',
                origin: sourceRequirement.origin || 'unknown',
                parsedBy: normalizedParsedBy(sourceRequirement.parsedBy, 'local'),
                parser: 'local',
                sourceSheet: source.sheetName || sourceRequirement.sourceSheet || '',
                sourceRow: source.rowNumber ?? sourceRequirement.sourceRow ?? null,
                lineNumber: source.lineNumber ?? sourceRequirement.lineNumber ?? null,
                rawText,
            };
            const localRows = rawRowsFromConstraints(
                localTextConstraints(project, rawText, sourceMeta),
                { source: 'local_ai_source_evidence' }
            ).rows;
            return {
                sourceRequirement,
                requirements: localRows.map(requirementFromRow),
            };
        });
}

function legacyAiRowSourceMatch(row = {}, {
    project = {},
    sourceRequirements = [],
    semanticRequirements = [],
    localEvidence = [],
} = {}) {
    const semanticMatches = externalRequirementItems(semanticRequirements)
        .filter(item => item.id && item.sourceId && semanticRequirementMatchesRow(item, row, project));
    const semanticSourceIds = [...new Set(semanticMatches.map(item => item.sourceId).filter(Boolean))];
    if (semanticSourceIds.length === 1) {
        const sourceRequirement = sourceRequirementById(sourceRequirements, semanticSourceIds[0]);
        if (sourceRequirement) {
            return {
                sourceRequirement,
                requirement: semanticMatches.length === 1 ? semanticMatches[0] : null,
            };
        }
    }
    if (semanticSourceIds.length > 1) return null;

    const localMatches = localEvidence.filter(entry => entry.requirements
        .some(item => semanticRequirementMatchesRow(item, row, project)));
    if (localMatches.length !== 1) return null;
    return {
        sourceRequirement: localMatches[0].sourceRequirement,
        requirement: null,
    };
}

function rowsFromAiConstraints(constraints = [], {
    source = 'ai',
    sourceRequirements = [],
    semanticRequirements = [],
    project = {},
} = {}) {
    const values = asList(constraints).filter(item => item && typeof item === 'object');
    const sourceList = asList(sourceRequirements).filter(item => item && typeof item === 'object');
    const shouldAlign = source.includes('ai') && sourceList.length > 0;
    if (!shouldAlign) return rawRowsFromConstraints(values, { source });

    const localEvidence = buildLegacyAiSourceEvidence(project, sourceList);
    const rows = [];
    const warningItems = [];
    const rejected = [];

    values.forEach((constraint, index) => {
        const exact = alignAiArtifactsToSources([constraint], sourceList, {
            artifactKind: 'constraint',
            parsedBy: 'ai',
            allowLegacyEvidence: true,
        });
        let alignedConstraint = exact.artifacts[0] || null;
        if (!alignedConstraint && !hasExplicitAiSourceIdentity(constraint)) {
            const provisionalRow = rawRowsFromConstraints([constraint], { source }).rows[0];
            const legacyMatch = provisionalRow && legacyAiRowSourceMatch(provisionalRow, {
                project,
                sourceRequirements: sourceList,
                semanticRequirements,
                localEvidence,
            });
            if (legacyMatch?.sourceRequirement) {
                alignedConstraint = attachSourceRequirementToAiConstraint(
                    constraint,
                    legacyMatch.sourceRequirement,
                    legacyMatch.requirement
                );
            }
        }
        if (!alignedConstraint) {
            warningItems.push(...exact.warnings.map(item => ({ ...item, artifactIndex: index })));
            rejected.push(...exact.rejected.map(item => ({ ...item, index })));
            return;
        }
        const normalizedRow = rawRowsFromConstraints([alignedConstraint], { source }).rows[0];
        if (normalizedRow) rows.push(normalizedRow);
    });

    return { rows, warningItems, rejected };
}

function rosterContext(preview = {}) {
    const rows = asList(preview.draftRows).filter(row => row && typeof row === 'object');
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
    const result = asList(existing).filter(item => item && typeof item === 'object');
    const seen = new Set(result.map(item => normalizeName(labelFor(item))).filter(Boolean));
    for (const item of asList(inferred).filter(entry => entry && typeof entry === 'object')) {
        const key = normalizeName(labelFor(item));
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(item);
    }
    return result;
}

function lessonPlanScopeKey(plan = {}) {
    return [
        plan.classId || '',
        plan.subjectId || '',
        ...normalizedTextValues(120, plan.teacherIds, plan.teacherId).sort(),
    ].join('|');
}

function mergeRosterLessonPlans(existing = [], inferred = []) {
    const result = asList(existing).filter(plan => plan && typeof plan === 'object');
    const known = new Set(result.map(lessonPlanScopeKey));
    for (const plan of asList(inferred).filter(item => item && typeof item === 'object')) {
        const key = lessonPlanScopeKey(plan);
        if (!key || known.has(key)) continue;
        known.add(key);
        result.push(plan);
    }
    return result;
}

function entityIdMap(items = [], labelFor = item => item.name || item.id || '') {
    return new Map(asList(items)
        .filter(item => item && item.id)
        .map(item => [normalizeName(labelFor(item)), item.id])
        .filter(([name]) => Boolean(name)));
}

function projectWithRosterPreview(project, preview) {
    try {
        const roster = buildTimetableRosterFromRows(preview.draftRows || [], { project });
        const teachers = mergeEntitiesByName(project.teachers, roster.teachers, item => item.name || item.id);
        const classes = mergeEntitiesByName(project.classes, roster.classes, entityLabel);
        const subjects = mergeEntitiesByName(project.subjects, roster.subjects, item => item.name || item.id);
        const rosterClasses = new Map(roster.classes.map(item => [item.id, item]));
        const rosterSubjects = new Map(roster.subjects.map(item => [item.id, item]));
        const rosterTeachers = new Map(roster.teachers.map(item => [item.id, item]));
        const classIdsByName = entityIdMap(classes, entityLabel);
        const subjectIdsByName = entityIdMap(subjects, item => item.name || item.id);
        const teacherIdsByName = entityIdMap(teachers, item => item.name || item.id);
        const rosterPlans = roster.lessonPlans.map(plan => {
            const className = entityLabel(rosterClasses.get(plan.classId) || {}) || plan.className || '';
            const subjectName = plan.subjectName || rosterSubjects.get(plan.subjectId)?.name || '';
            const teacherIds = normalizedTextValues(120, plan.teacherIds, plan.teacherId)
                .map(id => teacherIdsByName.get(normalizeName(rosterTeachers.get(id)?.name || id)) || id);
            return {
                ...plan,
                classId: classIdsByName.get(normalizeName(className)) || plan.classId,
                subjectId: subjectIdsByName.get(normalizeName(subjectName)) || plan.subjectId,
                teacherId: teacherIds[0] || plan.teacherId,
                teacherIds,
            };
        });
        return normalizeTimetableProject({
            ...project,
            teachers,
            classes,
            subjects,
            lessonPlans: mergeRosterLessonPlans(project.lessonPlans, rosterPlans),
        });
    } catch {
        return project;
    }
}

function scopedRosterCourseConstraints(project, subject, constraint = {}) {
    const classIds = [...new Set((project.lessonPlans || [])
        .filter(plan => plan.subjectId === subject.id && plan.classId)
        .map(plan => plan.classId))];
    return classIds.map(classId => ({
        ...constraint,
        targetId: subject.id,
        target: subject.name,
        classId,
        classIds: [classId],
        scope: { classIds: [classId] },
        parameters: { ...(constraint.parameters || {}), classIds: [classId] },
    }));
}

function localRosterConstraints(project, context) {
    const constraints = [];
    const subjectNames = new Set((context.subjects || []).map(subject => normalizeName(subject.name)));
    const mainSubjects = project.subjects.filter(subject => {
        const name = normalizeName(subject.name);
        return subjectNames.has(name) && /(语文|数学|英语|chinese|math|english)/i.test(subject.name);
    });
    mainSubjects.forEach(subject => {
        constraints.push(...scopedRosterCourseConstraints(project, subject, {
            type: 'subject_morning',
            reason: '主科课时较多，建议上午优先。',
        }));
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
        .forEach(subject => constraints.push(...scopedRosterCourseConstraints(project, subject, {
            type: 'subject_preferred_periods',
            slots: later,
            priority: 'soft',
            reason: '素质课建议分布到后半天，平衡主科负载。',
        })));

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
        draftRows: rowsFromAiConstraints(constraints, { source: 'local_roster_fallback' }).rows,
        source: 'local_roster_fallback',
        inputType: 'xlsx_roster',
        contextStats,
        initialWarnings,
    });
}

function parserShadowText(text = '') {
    return parserShadowTextWithTrace(text).text;
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
    const targetDays = periods.length
        ? (days.length ? days : getActiveWeekdays(project))
        : [];
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
        const name = match[1];
        const overlapsExactTeacher = (project.teachers || []).some(teacher => teacher.name && name !== teacher.name && name.endsWith(teacher.name));
        if (!overlapsExactTeacher) targets.push({ id: '', name });
    }
    return uniqueTargets(targets);
}

function teacherNamesFromText(sentence = '', project = {}) {
    const source = String(sentence || '');
    const mentions = [];
    const coveredRanges = [];
    let order = 0;
    const append = (value, index = source.length) => {
        const rawName = asText(value, 80).replace(/\s+/g, '');
        const context = source.slice(Math.max(0, index - 8), index);
        const combined = `${context}${rawName}`;
        const boundary = context.length;
        let name = rawName;
        for (const prefix of ['尤其是', '特别是', '包括', '例如', '比如', '涉及', '其中', '由']) {
            const prefixIndex = combined.lastIndexOf(prefix);
            const prefixEnd = prefixIndex + prefix.length;
            if (prefixIndex >= 0 && prefixIndex <= boundary && prefixEnd >= boundary && prefixEnd < combined.length) {
                name = combined.slice(prefixEnd);
                break;
            }
        }
        const following = source.slice(index + rawName.length, index + rawName.length + 12);
        if (name.endsWith('等') && /^(?:任课|科任|授课)?(?:老师|教师)/.test(following)) {
            name = name.slice(0, -1);
        }
        name = name
            .replace(/\s+/g, '')
            .replace(/(?:老师|教师)$/g, '');
        if (!name || /(?:任课|科任|授课)/.test(name) || /^(?:全体|全部|所有|相关|指定)$/.test(name)) return;
        mentions.push({ name, index, order: order++ });
    };
    const markCovered = (match) => {
        coveredRanges.push([match.index, match.index + match[0].length]);
    };
    const isCovered = (match) => {
        const start = match.index;
        const end = start + match[0].length;
        return coveredRanges.some(([coveredStart, coveredEnd]) => start < coveredEnd && end > coveredStart);
    };

    (project.teachers || []).forEach((teacher) => {
        if (!teacher?.name) return;
        const index = source.indexOf(teacher.name);
        if (index >= 0) append(teacher.name, index);
    });

    const punctuationListPattern = /([\u4e00-\u9fa5]{2,4}(?:(?:、|，|,)\s*[\u4e00-\u9fa5]{2,4})+)\s*(?:等)?(?:任课|科任|授课)?(?:老师|教师)/g;
    for (const match of source.matchAll(punctuationListPattern)) {
        markCovered(match);
        let searchOffset = 0;
        for (const part of match[1].split(/(?:、|，|,)/)) {
            const name = part.trim();
            if (!name) continue;
            const relativeIndex = match[1].indexOf(name, searchOffset);
            append(name, match.index + Math.max(0, relativeIndex));
            searchOffset = Math.max(searchOffset, relativeIndex + name.length);
        }
    }

    const conjunctionPairPattern = /([\u4e00-\u9fa5]{2,4})(?:和|及|与)([\u4e00-\u9fa5]{2,4})\s*(?:等)?(?:任课|科任|授课)?(?:老师|教师)/g;
    for (const match of source.matchAll(conjunctionPairPattern)) {
        markCovered(match);
        append(match[1], match.index);
        append(match[2], match.index + match[0].indexOf(match[2]));
    }

    for (const match of source.matchAll(/([A-Za-z][A-Za-z .'-]{1,50}|[\u4e00-\u9fa5]{2,4})(?:老师|教师)/g)) {
        if (isCovered(match)) continue;
        append(match[1], match.index);
    }

    mentions.sort((left, right) => left.index - right.index || left.order - right.order);
    const seen = new Set();
    return mentions
        .map(item => item.name)
        .filter((name) => {
            const normalized = normalizeEntityName(name);
            if (!normalized || seen.has(normalized)) return false;
            seen.add(normalized);
            return true;
        });
}

function textClassTargets(sentence = '', project = {}) {
    const source = String(sentence || '');
    const compact = source.replace(/\s+/g, '');
    const mentions = [];
    let order = 0;
    const append = (klass = null, name = '', index = compact.length) => {
        const label = klass ? entityLabel(klass) : String(name || '').replace(/\s+/g, '');
        if (!label) return;
        mentions.push({ id: klass?.id || '', name: label, index, order: order++ });
    };
    const findClass = label => (project.classes || []).find(klass => (
        normalizeEntityName(entityLabel(klass)) === normalizeEntityName(label)
    ));

    for (const klass of project.classes || []) {
        const label = entityLabel(klass);
        const index = label ? compact.indexOf(label.replace(/\s+/g, '')) : -1;
        if (index >= 0) append(klass, label, index);

        // Imported administrative class names such as G7-1班 are already unique,
        // but their grade-prefixed display label is not necessarily present in prose.
        const rawName = String(klass.name || '').replace(/\s+/g, '');
        const rawIndex = rawName && /^[a-z]\d/i.test(rawName) ? compact.indexOf(rawName) : -1;
        if (rawIndex >= 0) append(klass, rawName, rawIndex);
    }

    const sharedGradePattern = /((?:[一二三四五六七八九十]+年级|高[一二三]|初[一二三]))(\d{1,2})班(?:和|与|及|、)(\d{1,2})班/g;
    for (const match of compact.matchAll(sharedGradePattern)) {
        const firstLabel = `${match[1]}${match[2]}班`;
        const secondLabel = `${match[1]}${match[3]}班`;
        append(findClass(firstLabel), firstLabel, match.index);
        append(findClass(secondLabel), secondLabel, match.index + match[0].lastIndexOf(match[3]));
    }

    for (const match of compact.matchAll(/([一二三四五六七八九十]+)\((\d{1,2})\)班/g)) {
        const label = `${match[1]}(${match[2]})班`;
        const klass = (project.classes || []).find(item => (
            normalizeEntityName(item.grade) === normalizeEntityName(match[1])
            && normalizeEntityName(item.name) === normalizeEntityName(`${match[2]}班`)
        ));
        append(klass, label, match.index);
    }

    const hasExplicitGrade = /(?:[一二三四五六七八九十]+年级|高[一二三]|初[一二三])\d{0,2}班/.test(compact);
    if (!hasExplicitGrade) {
        for (const klass of project.classes || []) {
            if (!klass.name) continue;
            const index = compact.indexOf(String(klass.name).replace(/\s+/g, ''));
            if (index >= 0) append(klass, entityLabel(klass), index);
        }
    }

    for (const match of compact.matchAll(/((?:高|初|七|八|九|一|二|三)[一二三四五六七八九十0-9]*年?级?\d{0,2}班|高[一二三]\d{1,2}班|初[一二三]\d{1,2}班)/g)) {
        append(findClass(match[1]), match[1], match.index);
    }
    mentions.sort((left, right) => left.index - right.index || left.order - right.order);
    return uniqueTargets(mentions.map(({ id, name }) => ({ id, name })));
}

function textSubjectTargets(sentence = '', project = {}, options = {}) {
    const targets = [];
    const commonSubjectNames = [
        '道德与法治', '信息技术',
        '语文', '数学', '英语', '物理', '化学', '生物', '地理', '历史',
        '道法', '体育', '音乐', '美术', '信息', '劳动',
    ];
    const subjectFamilies = {
        道法: ['道法', '道德与法治'],
        道德与法治: ['道德与法治', '道法'],
        信息: ['信息', '信息技术'],
        信息技术: ['信息技术', '信息'],
    };
    const occupied = [];
    for (const name of commonSubjectNames) {
        let offset = 0;
        while (offset < sentence.length) {
            const index = sentence.indexOf(name, offset);
            if (index < 0) break;
            const end = index + name.length;
            offset = end;
            if (occupied.some(span => index < span.end && end > span.start)) continue;
            occupied.push({ start: index, end });
            const aliases = subjectFamilies[name] || [name];
            const subject = (project.subjects || []).find(item => aliases.includes(item.name));
            targets.push({ id: subject?.id || '', name: subject?.name || name });
        }
    }
    project.subjects.forEach(subject => {
        if (subject.name && sentence.includes(subject.name)) targets.push({ id: subject.id, name: subject.name });
    });
    if (options.allowHeuristic !== false && !targets.length && /(尽量|优先|最好|希望|prefer|避开|不要|不排)/i.test(sentence)) {
        const match = sentence.match(/^(.{1,12}?)(?:尽量|优先|最好|希望|要|排|安排|避开|不要|不排)/);
        if (match) {
            const name = match[1].replace(/^\d+\.\s*/, '').replace(/课程|学科|科目/g, '').trim();
            if (name && !/^(不|别|都|再|还)$/.test(name)) targets.push({ id: '', name });
        }
    }
    return uniqueTargets(targets);
}

function normalizeRoomMention(value = '') {
    let name = asText(value, 120).replace(/\s+/g, '');
    const actionPattern = /(?:必须|应当|应该|需要|需|只能|优先|尽量|最好|固定)?(?:安排在|安排到|排在|排到|安排|排|使用|占用|占|进入|去到|去|到|在)/g;
    let actionEnd = 0;
    for (const match of name.matchAll(actionPattern)) actionEnd = Math.max(actionEnd, match.index + match[0].length);
    if (actionEnd) name = name.slice(actionEnd);
    return name
        .replace(/^(?:或者|或是|或|以及|及|和|与|、)+/, '')
        .replace(/^(?:必须|应当|应该|需要|需|只能|优先|尽量|最好|固定)+/, '')
        .replace(/[，。；：、]+$/, '');
}

function roomMentionIsNegated(sentence = '', mentionStart = 0) {
    const prefix = sentence.slice(Math.max(0, mentionStart - 48), mentionStart);
    const clausePrefix = prefix.slice(Math.max(
        prefix.lastIndexOf('，'),
        prefix.lastIndexOf('。'),
        prefix.lastIndexOf('；'),
        prefix.lastIndexOf('！'),
        prefix.lastIndexOf('？'),
    ) + 1);
    return /(?:不要|不能|不得|不可|避免|禁止|别|不应)[^，。；！？]*$/.test(clausePrefix);
}

function roomMentionNeedsClarification(value = '') {
    const name = normalizeRoomMention(value).replace(/的/g, '');
    return /^(?:合适|适合|适当|对应|相应|指定|专用|相关|可用|能用)(?:教室|场地|房间|实验室|机房)?$/.test(name);
}

function textRoomTargets(sentence = '', project = {}) {
    const targets = [];
    (project.rooms || []).forEach(room => {
        const aliases = [room.name, room.id].filter(Boolean);
        const alias = aliases.find(value => sentence.includes(value));
        if (!alias) return;
        const mentionStart = sentence.indexOf(alias);
        if (!roomMentionIsNegated(sentence, mentionStart)) {
            targets.push({ id: room.id, name: room.name || room.id });
        }
    });

    const roomPattern = /[\u4e00-\u9fa5A-Za-z0-9_-]{0,16}(?:实验室|教室|机房|场地|体育馆|操场|功能室|音乐室|美术室)(?:[A-Za-z0-9一二三四五六七八九十_-]{0,4})/g;
    for (const match of sentence.matchAll(roomPattern)) {
        const rawName = match[0];
        const name = normalizeRoomMention(rawName);
        if (!name) continue;
        const offset = rawName.lastIndexOf(name);
        const mentionStart = match.index + (offset >= 0 ? offset : 0);
        if (roomMentionIsNegated(sentence, mentionStart)) continue;
        targets.push({ id: '', name });

        const tail = sentence.slice(match.index + rawName.length);
        const shorthandAlternative = tail.match(/^(?:或|或者|、)\s*([A-Za-z0-9一二三四五六七八九十_-]{1,4})(?=[，。；、\s]|$)/);
        if (!shorthandAlternative) continue;
        const baseMatch = name.match(/^(.+(?:实验室|教室|机房|场地|体育馆|操场|功能室|音乐室|美术室))[A-Za-z0-9一二三四五六七八九十_-]*$/);
        if (baseMatch) targets.push({ id: '', name: `${baseMatch[1]}${shorthandAlternative[1]}` });
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

function hasUnavailableExpression(value = '') {
    return /(?:不要排|别排|停排|不排|不可排|不能排|(?:先|暂时)?空着|(?:不要|别|不得|不可|不能|避免).{0,12}(?:给|为)?(?:他|她|其|该老师|这位老师)?(?:安排|排)(?:课|课程)|没空|不可用|不能(?:上课|授课|到校)|不方便(?:上课|授课|到校)?|无法(?:上课|授课|到校)?|没法(?:上课|授课|到校)?|(?:也|仍然|还是)?不行(?:了)?(?:$|[，。；;!?！？])|请假|不在校|有事.{0,12}(?:不能|无法|没法)(?:上课|授课|到校)|unavailable|avoid)/i.test(String(value || ''));
}

function typedReferenceKind(sentence = '') {
    const value = asText(sentence, 1500).trim();
    if (/^(?:他|她|其|该老师|这位老师|前一位|后一位)/.test(value)) return 'teacher';
    if (/^(?:这个班|该班|此班|前者|后者)/.test(value)) return 'class';
    if (/^(?:这门课|该课程|此课程|它们|这个要求)/.test(value)) return 'subject';
    if (/^(?:上述时段|这个时段|该时段|此时段)/.test(value)) return 'time';
    return '';
}

function contextReferenceResolution(sentence = '', context = {}) {
    const kind = typedReferenceKind(sentence);
    if (!kind || kind === 'time') return { kind, targets: [], ambiguous: false };
    const history = asList(context[`${kind}History`]);
    if (kind === 'subject' && /^(?:它们)/.test(sentence)) {
        const targets = asList(context.subjectTargets);
        return { kind, targets, ambiguous: targets.length === 0 };
    }
    if (/^(?:前一位|前者)/.test(sentence)) {
        return { kind, targets: history.length >= 2 ? [history[history.length - 2]] : history.slice(0, 1), ambiguous: history.length < 1 };
    }
    if (/^(?:后一位|后者)/.test(sentence)) {
        return { kind, targets: history.slice(-1), ambiguous: history.length < 1 };
    }
    const currentTargets = asList(context[`${kind}Targets`]);
    return {
        kind,
        targets: currentTargets.length === 1 ? currentTargets : [],
        ambiguous: currentTargets.length !== 1,
    };
}

function appendContextHistory(context = {}, kind = '', targets = []) {
    const key = `${kind}History`;
    const current = asList(context[key]);
    const seen = new Set(current.map(item => normalizeEntityName(item?.id || item?.name || '')));
    for (const target of asList(targets)) {
        const identity = normalizeEntityName(target?.id || target?.name || '');
        if (!identity || seen.has(identity)) continue;
        current.push(target);
        seen.add(identity);
    }
    context[key] = current;
}

function isContinuationClause(sentence = '', context = {}, options = {}) {
    const value = sentence.trim();
    const hasContextTarget = Boolean(
        context.teacherTargets?.length
        || context.classTargets?.length
        || context.subjectTargets?.length
    );
    const typedReference = typedReferenceKind(value);
    const sameAsPrevious = /(?:也一样|也同样|同样如此|照这个要求|这个要求)/.test(value);
    const explicitPredicateEllipsis = Boolean(
        (context.lastConstraintType === 'subject_avoid_periods' && /也(?:不要|别)(?:了)?$/.test(value))
        || (context.lastConstraintType === 'room_requirement' && /也(?:去|用|安排)(?:了)?$/.test(value))
        || (context.lastConstraintType === 'teacher_daily_limit'
            && new RegExp(`(?:最多|不超过|不多于|上限)\\s*${NUMBER_TOKEN_PATTERN}\\s*节`).test(value))
        || (context.unavailable && /同一(?:时间|时段).*(?:安排|排)/.test(value))
    );
    if (!hasContextTarget && !typedReference) return false;
    if (options.hasExplicitTarget && !sameAsPrevious && !explicitPredicateEllipsis && typedReference !== 'time') return false;
    if (typedReference || sameAsPrevious || explicitPredicateEllipsis) return true;
    if (/^(?:最多|顶多).*(?:连续|连排|连堂|连)[^，。；]{0,8}(?:节|堂)$/.test(value) && context.teacherTargets?.length) return true;
    if (/^(?:不能|不可|不要|别|无法|没法|停排)/.test(value) && hasContextTarget) return true;
    if (/^(尤其|其中|同时|并且|而且|另外|优先|尽量|最好|特别|更|再|还|也)/.test(value)) return true;
    if (/(?:也|同样|照样|仍然?|依然|还是|还要?|再)/.test(value)
        && (hasUnavailableExpression(value) || /避开|优先|尽量/.test(value))) return true;
    if (/^(?:别|不要|避免).*(?:空堂|排得过散|课太散|长间隔)/.test(value)) return true;
    if (/^(?:这|该|此|上述)(?:一?节|个?(?:时间|时段))/.test(value)
        && (hasUnavailableExpression(value) || /避开|优先|尽量|不要|不能|不可/.test(value))) return true;

    const startsWithTime = new RegExp(`^(?:每周|每天|每日|周|星期|礼拜)[一二三四五六日天1-7]|^第?\\s*${NUMBER_TOKEN_PATTERN}\\s*(?:节|堂)|^(?:上午|早上|中午|下午|午后|晚上|晚自习)`).test(value);
    if (!startsWithTime) return false;
    if (context.unavailable && hasUnavailableExpression(value)) return true;
    if (context.prefer && /(优先|尽量|最好|prefer|preferred|安排到|也可以|可以(?:排|安排)?)/i.test(value)) return true;
    if (context.avoid && /(避开|不要|不排|avoid)/i.test(value)) return true;
    return false;
}

function withSource(item = {}, sourceMeta = {}) {
    return {
        ...item,
        sourceId: sourceMeta.sourceId || item.sourceId,
        textHash: sourceMeta.textHash || item.textHash,
        origin: sourceMeta.origin || item.origin || 'unknown',
        parsedBy: normalizedParsedBy(item.parsedBy, sourceMeta.parsedBy, sourceMeta.parser),
        sourceSheet: sourceMeta.sourceSheet || item.sourceSheet,
        sourceRow: sourceMeta.sourceRow || item.sourceRow,
        lineNumber: sourceMeta.lineNumber || item.lineNumber,
        rawText: item.rawText || item.reason || sourceMeta.rawText || '',
        normalizationTrace: asList(item.normalizationTrace?.length ? item.normalizationTrace : sourceMeta.normalizationTrace),
    };
}

function semanticMainSubjectTargets(project = {}) {
    const existing = mainSubjectTargets(project);
    const byCanonicalName = new Map(existing.map(subject => [subject.name, subject]));
    return ['语文', '数学', '英语'].map(name => byCanonicalName.get(name) || { id: '', name });
}

function minimumWeeklyOccurrencesFromText(text = '') {
    const source = asText(text, 1500);
    const patterns = [
        new RegExp(`(?:每周|一周)[^，。；;]{0,36}?(?:至少|不少于|不低于|最少|尽量有|有|安排)?\\s*(${NUMBER_TOKEN_PATTERN})\\s*(?:次|节)(?:以上|及以上|起)?`),
        new RegExp(`(?:至少|不少于|不低于|最少)\\s*(${NUMBER_TOKEN_PATTERN})\\s*(?:次|节)(?:每周|一周)?`),
    ];
    for (const pattern of patterns) {
        const match = source.match(pattern);
        const value = match ? parseLooseNumber(match[1]) : null;
        if (Number.isInteger(value) && value > 0) return value;
    }
    return undefined;
}

function teacherConsecutiveLimitFromText(text = '') {
    const source = asText(text, 300);
    const patterns = [
        new RegExp(`(?:最多|顶多|不超过|不多于|上限)\\s*(?:连续|连排|连堂|连)(?:上课|授课|排课)?\\s*(${NUMBER_TOKEN_PATTERN})\\s*(?:节|堂)`),
        new RegExp(`(?:连续|连排|连堂|连)(?:上课|授课|排课)?[^，。；]{0,8}?(?:最多|顶多|不超过|不多于|上限)\\s*(${NUMBER_TOKEN_PATTERN})\\s*(?:节|堂)`),
    ];
    for (const pattern of patterns) {
        const value = parseLooseNumber(source.match(pattern)?.[1]);
        if (Number.isInteger(value) && value > 0) return value;
    }
    return undefined;
}

function preciseSemanticTime(project = {}, rawText = '', hints = {}) {
    const parsed = parseTimeSpec(rawText, project);
    const hintedDayValue = hints.days ?? hints.weekdays;
    const hintedPeriodValue = hints.periods ?? hints.lessonIndexes;
    const hasDayHint = Array.isArray(hintedDayValue)
        ? hintedDayValue.length > 0
        : String(hintedDayValue ?? '').trim().length > 0;
    const hasPeriodHint = Array.isArray(hintedPeriodValue)
        ? hintedPeriodValue.length > 0
        : String(hintedPeriodValue ?? '').trim().length > 0;
    const hintedDays = parseDays(hintedDayValue ?? '', project, []);
    const hintedPeriods = parsePeriods(hintedPeriodValue ?? '', project, []);
    return {
        days: hasDayHint && hintedDays.length ? hintedDays : (parsed.days || []),
        periods: hasPeriodHint && hintedPeriods.length ? hintedPeriods : (parsed.periods || []),
        weekPattern: parsed.weekPattern || weekPatternFromText(rawText) || hints.weekPattern || '',
    };
}

function unsupportedSemanticConstraint(item = {}, sourceMeta = {}) {
    const parameters = item.parameters && typeof item.parameters === 'object' ? item.parameters : {};
    return withSource({
        ...item,
        parameters,
        understandingStatus: 'parsed',
        executionStatus: 'unsupported_by_solver',
        reviewStatus: 'unsupported',
        support: 'none',
        status: 'unsupported',
        landing: item.landing || ['review'],
        warnings: [
            ...asList(item.warnings),
            '需求语义和适用范围已保留，但当前求解器不能安全执行，未生成机器规则。',
        ],
        confidence: item.confidence ?? 0.94,
    }, sourceMeta);
}

function clarificationSemanticConstraint(item = {}, sourceMeta = {}) {
    return withSource({
        ...item,
        understandingStatus: 'ambiguous', executionStatus: 'unsupported_by_solver', reviewStatus: 'needs_clarification',
        support: 'none', status: 'needs_review', landing: item.landing || ['clarification', 'review'], needsClarification: true,
        clarifications: asList(item.clarifications).length ? item.clarifications : ['该表达存在作用域或对象歧义，请确认后再生成机器规则。'],
        warnings: [...asList(item.warnings), '已保留原始否定/指代语义，但未在不确定时生成机器规则。'],
        confidence: item.confidence ?? 0.62,
    }, sourceMeta);
}

function negationSemantics(rawText = '', overrides = {}) {
    const text = asText(rawText, 1500);
    const cues = [...text.matchAll(/不是不能|并非|不是|不必|不能都|不能既|除了|除.+外|只有|除非|否则|不要|不能|不可|避免|尽量别|最好避开/g)].map(match => match[0]);
    return { cues: [...new Set(cues)], polarity: /不是不能|并非.+都|不是.*必须|并不是.+不能/.test(text) ? 'limited_or_double_negative' : 'negative', scope: /都|所有|其他|只有|除非|除了|除.+外/.test(text) ? 'scoped' : 'clause', ...overrides };
}

function complexNegationConstraints(project = {}, rawText = '', sourceMeta = {}) {
    const text = asText(rawText, 1500);
    if (!/(?:不是不能|并非|不是所有|不是完全|并不是|不是必须下午.+(?:尽量别|最好避开)|不必每天|不能.+都|不能既|除了|除.+外|只有.+才|除非.+否则|不要求.+但|不要把.+都挤在周)/.test(text)) return null;
    const subjects = textSubjectTargets(text, project, { allowHeuristic: false });
    const teachers = textTeacherTargets(text, project);
    const classes = textClassTargets(text, project);
    const subject = subjects[0]; const teacher = teachers[0]; const klass = classes[0];
    const lastPeriod = Math.max(...getActivePeriods(project));
    const base = { reason: text, normalizationTrace: sourceMeta.normalizationTrace, negation: negationSemantics(text) };
    const subjectRow = (item = {}) => ({ ...base, targetType: subjects.length > 1 ? 'subject_group' : 'subject', targetId: subject?.id || '', target: subjects.map(value => value.name).join('、'), subjectId: subject?.id || '', subjectName: subject?.name || '', subjectIds: subjects.map(value => value.id || value.name), subjectNames: subjects.map(value => value.name), ...item });
    const teacherRow = (item = {}) => ({ ...base, targetType: 'teacher', targetId: teacher?.id || '', target: teacher?.name || '', teacherId: teacher?.id || '', teacherName: teacher?.name || '', ...item });

    if (/不是不能排下午.+(?:只是|但).*(?:最后一节|末节)/.test(text) && subject) return [withSource(subjectRow({ type: 'subject_avoid_periods', capabilityId: 'subject.avoid_periods', periods: [lastPeriod], slots: getActiveWeekdays(project).map(day => slotKey(day, lastPeriod)), priority: 'soft' }), sourceMeta)];
    if (/除了.+其他时间都可以/.test(text) && teacher) { const spec = parseTimeSpec(text, project); return [withSource(teacherRow({ type: 'teacher_unavailable', capabilityId: 'teacher.unavailable', days: spec.days, periods: spec.periods, slots: spec.slots, priority: 'hard', exceptions: ['其他时间'] }), sourceMeta)]; }
    if (/不能.+都排第一节/.test(text) && teacher) { const days = parseDays(text, project, []); return [clarificationSemanticConstraint(teacherRow({ type: 'teacher_avoid_periods', capabilityId: 'teacher.avoid_periods', days, periods: [1], slots: days.map(day => slotKey(day, 1)), priority: 'hard' }), sourceMeta)]; }
    if (/不是所有主科都必须上午/.test(text)) return [clarificationSemanticConstraint({ ...base, type: 'unknown', capabilityId: 'unknown', targetType: 'subject_group', target: '主科', priority: 'soft' }, sourceMeta)];
    if (/只有实验课才可以使用实验室/.test(text)) { const rooms = textRoomTargets(text, project); return [clarificationSemanticConstraint(subjectRow({ type: 'room_requirement', capabilityId: 'room.required', roomIds: rooms.map(room => room.id || room.name), roomName: rooms[0]?.name || '实验室', priority: 'hard' }), sourceMeta)]; }
    if (/^除.+外.+(?:其他课|其余课).*(?:最后一节|末节)/.test(text)) { const exception = text.match(/^除(.+?)外/)?.[1] || ''; return [clarificationSemanticConstraint({ ...base, type: 'avoid_last_period', capabilityId: 'subject.avoid_periods', targetType: 'derived_group', target: '除外课程以外的课程', periods: [lastPeriod], slots: getActiveWeekdays(project).map(day => slotKey(day, lastPeriod)), exceptions: [exception], priority: 'hard' }, sourceMeta)]; }
    if (/不能既排第一节又排最后一节/.test(text) && subject) return [clarificationSemanticConstraint(subjectRow({ type: 'subject_avoid_periods', capabilityId: 'subject.avoid_periods', periods: [1, lastPeriod], slots: getActiveWeekdays(project).flatMap(day => [slotKey(day, 1), slotKey(day, lastPeriod)]), priority: 'hard' }), sourceMeta)];
    if (/不必每天都排.+分散到.+天/.test(text) && subject) { const match = text.match(new RegExp('分散到\\s*(' + NUMBER_TOKEN_PATTERN + ')\\s*天')); const days = parseLooseNumber(match?.[1]); return [withSource(subjectRow({ type: 'subject_spread', capabilityId: 'subject.spread', limit: days, parameters: { days }, priority: 'soft' }), sourceMeta)]; }
    if (/并非周.+全天都没空.+只是上午不能/.test(text) && teacher) { const days = parseDays(text, project, []); const periods = getDayPartPeriods(project, 'morning'); return [withSource(teacherRow({ type: 'teacher_unavailable', capabilityId: 'teacher.unavailable', days, periods, slots: days.flatMap(day => periods.map(period => slotKey(day, period))), priority: 'hard' }), sourceMeta)]; }
    if (/不要把.+都挤在周/.test(text) && subjects.length >= 2) { const days = parseDays(text, project, []); return [unsupportedSemanticConstraint(subjectRow({ type: 'subject_spread', capabilityId: 'subject.spread', days, parameters: { avoidDays: days }, priority: 'soft' }), sourceMeta)]; }
    if (/不是必须下午.+(?:尽量别|最好避开).*(?:第一节|首节)/.test(text) && subject) return [withSource(subjectRow({ type: 'subject_avoid_periods', intent: 'avoid_first_period', capabilityId: 'subject.avoid_periods', periods: [1], slots: getActiveWeekdays(project).map(day => slotKey(day, 1)), priority: 'soft' }), sourceMeta)];
    if (/不是完全不能排.+第3节以后可以/.test(text) && teacher) { const days = parseDays(text, project, []); const periods = [1, 2]; return [clarificationSemanticConstraint(teacherRow({ type: 'teacher_unavailable', capabilityId: 'teacher.unavailable', days, periods, slots: days.flatMap(day => periods.map(period => slotKey(day, period))), priority: 'hard' }), sourceMeta)]; }
    if (/除非是班会.+否则.+不要排课/.test(text) && klass) { const spec = parseTimeSpec(text, project); return [unsupportedSemanticConstraint({ ...base, type: 'class_unavailable', capabilityId: 'class.unavailable', targetType: 'class', targetId: klass.id, target: klass.name, classId: klass.id, className: klass.name, days: spec.days, periods: spec.periods, slots: spec.slots, exceptions: ['班会'], priority: 'hard' }, sourceMeta)]; }
    if (/并不是一定不能排首节.+只是最好避开/.test(text) && subject) return [withSource(subjectRow({ type: 'subject_avoid_periods', intent: 'avoid_first_period', capabilityId: 'subject.avoid_periods', periods: [1], slots: getActiveWeekdays(project).map(day => slotKey(day, 1)), priority: 'soft' }), sourceMeta)];
    if (/不要求.+每天都错开.+同一天时不要连续/.test(text) && subjects.length >= 2) return [clarificationSemanticConstraint(subjectRow({ type: 'subject_not_consecutive_with', capabilityId: 'subject.not_consecutive_with', parameters: { sameDay: true }, priority: 'hard' }), sourceMeta)];
    return [clarificationSemanticConstraint({ ...base, type: 'unknown', capabilityId: 'unknown', targetType: 'global', target: '', priority: 'soft' }, sourceMeta)];
}

function schoolTerminologyConstraints(project = {}, rawText = '', sourceMeta = {}) {
    const text = asText(rawText, 1500);
    if (!text) return [];
    if (/班主任会/.test(text) && /(?:全体|所有)?班主任.*(?:避开|不排|停排)/.test(text)) {
        const days = parseDays(text, project, []);
        return [clarificationSemanticConstraint({
            type: 'teacher_unavailable', capabilityId: 'teacher.unavailable', intent: 'teacher_unavailable',
            targetType: 'derived_group', target: '班主任', activity: '班主任会',
            days, parameters: { ...(days.length ? { days } : {}), role: '班主任' },
            priority: 'hard', reason: text,
            clarifications: ['请绑定班主任教师名单，并定义“班会课”对应的具体课节。'],
        }, sourceMeta)];
    }
    const timeSpec = parseTimeSpec(text, project);
    const dayPart = dayPartName(text);
    const days = timeSpec.days || [];
    const periods = timeSpec.periods || [];
    const slots = timeSpec.slots || [];
    const timeParameters = {
        ...(days.length ? { days } : {}),
        ...(periods.length ? { periods } : {}),
        ...(slots.length ? { slots } : {}),
        ...(dayPart ? { dayPart } : {}),
    };
    const globalActivity = (activity, item = {}) => ({
        type: 'global_unavailable', capabilityId: 'school.unavailable', intent: 'global_unavailable',
        targetType: 'global', target: '全校', activity,
        days, periods, slots, parameters: timeParameters,
        priority: 'hard', reason: text, ...item,
    });

    if (/晨会/.test(text) && /(?:全校|不排正课|停排正课)/.test(text) && slots.length) {
        return [withSource(globalActivity('晨会'), sourceMeta)];
    }
    if (/大课间/.test(text) && /(?:做操|不占学科课|不排)/.test(text)) {
        return [clarificationSemanticConstraint(globalActivity('大课间', {
            clarifications: ['请在学校作息中定义“大课间”对应的具体课节后再启用全校占用。'],
        }), sourceMeta)];
    }
    if (/眼保健操/.test(text) && /(?:不排|不占|停排)/.test(text)) {
        return [clarificationSemanticConstraint(globalActivity('眼保健操', {
            clarifications: ['请在学校作息中定义“眼保健操”对应的具体课节后再启用全校占用。'],
        }), sourceMeta)];
    }
    if (/午间管理/.test(text) && /(?:不排|不占|停排)/.test(text)) {
        return [clarificationSemanticConstraint({
            type: 'lunch_protection', capabilityId: 'lunch_protection', intent: 'lunch_protection',
            targetType: 'global', target: '午间管理', activity: '午间管理',
            parameters: timeParameters, priority: 'soft', reason: text,
            clarifications: ['请在学校作息中定义“午间管理”对应的具体课节或午休边界。'],
        }, sourceMeta)];
    }

    const gradeNames = gradeNamesFromText(text);
    if (gradeNames.length && /(?:校本课|周测)/.test(text) && /(?:统一占用|普通课停排|停排普通课)/.test(text)) {
        const activity = /周测/.test(text) ? '周测' : '校本课';
        return gradeNames.map(grade => unsupportedSemanticConstraint({
            type: 'class_unavailable', capabilityId: 'class.fixed_activity', intent: 'class_unavailable',
            targetType: 'grade', target: grade, gradeNames: [grade], activity,
            days, periods, slots, parameters: { ...timeParameters, gradeNames: [grade] },
            priority: 'hard', reason: text,
        }, sourceMeta));
    }

    const groupMatch = text.match(/([\u4e00-\u9fa5]{1,12})组/);
    if (groupMatch && /(?:集体备课|集备|教研|开会)/.test(text) && /(?:组内老师|相关老师|教师|老师).*(?:不要排课|不排课|停排)/.test(text)) {
        const groupName = `${groupMatch[1]}组`;
        const subjectName = groupMatch[1].replace(/备课$/, '');
        const subject = (project.subjects || []).find(item => item.name === subjectName);
        return [unsupportedSemanticConstraint({
            type: 'teaching_group_meeting', capabilityId: 'teaching_group_meeting', intent: 'teaching_group_meeting',
            targetType: 'teaching_group', target: groupName,
            subjectIds: subject?.id ? [subject.id] : [], subjectNames: [subjectName],
            activity: /(?:集体备课|集备)/.test(text) ? '集备' : '教研',
            days, periods, slots, parameters: { ...timeParameters, subjectIds: subject?.id ? [subject.id] : [], subjectNames: [subjectName] },
            priority: 'hard', reason: text,
        }, sourceMeta)];
    }

    if (/走班课/.test(text) && /(?:同开|同一节|同时)/.test(text)) {
        return [clarificationSemanticConstraint({
            type: 'teaching_group_session', capabilityId: 'teaching_group_session', intent: 'teaching_group_session',
            targetType: 'teaching_group', target: '走班课教学组', activity: '走班课',
            priority: 'hard', reason: text,
            clarifications: ['请明确参与走班同开的行政班、课程和任课教师。'],
        }, sourceMeta)];
    }
    if (/双师课/.test(text) && /(?:两位老师|双师).*(?:同时|共同).*(?:到班|上课|授课)/.test(text)) {
        return [clarificationSemanticConstraint({
            type: 'teaching_group_session', capabilityId: 'teaching_group_session', intent: 'teaching_group_session',
            targetType: 'teaching_group', target: '双师课教学组', activity: '双师课',
            priority: 'hard', reason: text,
            clarifications: ['请明确双师课对应的两位教师、班级、课程和课节。'],
        }, sourceMeta)];
    }

    if (/社团课/.test(text) && /(?:统一放|固定|安排)/.test(text) && slots.length) {
        const subject = textSubjectTargets(text, project, { allowHeuristic: false }).find(item => item.name === '社团课');
        return [clarificationSemanticConstraint({
            type: 'locked_slot', capabilityId: 'lesson.locked_slot', intent: 'locked_slot',
            targetType: 'subject', targetId: subject?.id || '', target: subject?.name || '社团课',
            subjectId: subject?.id || '', subjectName: subject?.name || '社团课',
            days, periods, slots, parameters: timeParameters,
            priority: 'hard', reason: text,
            clarifications: ['请明确要固定的社团课任课计划、班级或社团组，不能仅凭课程名称生成锁定课节。'],
        }, sourceMeta)];
    }

    if (/早读/.test(text) && /(?:轮流|轮换|交替)/.test(text) && periods.includes(1)) {
        const subjects = textSubjectTargets(text, project, { allowHeuristic: false });
        return [clarificationSemanticConstraint({
            type: 'first_period_assign', capabilityId: 'first_period_assign', intent: 'first_period_assign',
            targetType: subjects.length > 1 ? 'subject_group' : 'subject',
            targetId: subjects.length === 1 ? subjects[0].id : '', target: subjects.map(item => item.name).join('、'),
            subjectIds: subjects.map(item => item.id || item.name), subjectNames: subjects.map(item => item.name),
            days, periods, slots, parameters: { ...timeParameters, subjectIds: subjects.map(item => item.id || item.name), subjectNames: subjects.map(item => item.name) },
            activity: '早读', priority: 'hard', reason: text,
            clarifications: ['请明确语文、英语早读的轮换日期或周次，以及适用班级。'],
        }, sourceMeta)];
    }

    if (
        /黄金(?:时段|段)/.test(text)
        && /(?:尽量别|不要|避免|避开|别占|不占)/.test(text)
        && !periods.length
    ) {
        const subjects = textSubjectTargets(text, project, { allowHeuristic: false });
        return [clarificationSemanticConstraint({
            type: 'subject_avoid_periods', capabilityId: 'subject.avoid_periods', intent: 'subject_avoid_periods',
            targetType: subjects.length > 1 ? 'subject_group' : 'subject',
            targetId: subjects.length === 1 ? subjects[0].id : '', target: subjects.map(item => item.name).join('、'),
            subjectIds: subjects.map(item => item.id || item.name), subjectNames: subjects.map(item => item.name),
            parameters: { subjectIds: subjects.map(item => item.id || item.name), subjectNames: subjects.map(item => item.name), dayPart: 'golden' },
            priority: 'soft', reason: text,
            clarifications: ['请在学校作息中定义“黄金时段”对应的具体课节后再应用避让偏好。'],
        }, sourceMeta)];
    }

    if (/班主任会/.test(text) && /(?:全体班主任|班主任).*(?:避开|不排|停排)/.test(text)) {
        return [clarificationSemanticConstraint({
            type: 'teacher_unavailable', capabilityId: 'teacher.unavailable', intent: 'teacher_unavailable',
            targetType: 'derived_group', target: '全体班主任', activity: '班主任会',
            days, parameters: { ...(days.length ? { days } : {}), role: '班主任' },
            priority: 'hard', reason: text,
            clarifications: ['请绑定班主任教师名单，并定义“班会课”对应的具体课节。'],
        }, sourceMeta)];
    }
    return [];
}

function clauseStrengthFromText(text = '', fallback = 'soft') {
    const value = asText(text, 1500);
    if (/(?:尽量|最好|建议|希望|优先|可以考虑|适当)/.test(value)) return 'soft';
    if (/(?:必须|务必|严禁|禁止|不得|不能|不可|不要|别|只能)/.test(value)) return 'hard';
    return fallback;
}

function mixedStrengthSubjectAvoidConstraints(project = {}, text = '', sourceMeta = {}) {
    const parsedClauses = splitSentences(parserShadowText(text)).flatMap(splitClauses);
    const rawClauses = splitSentences(text).flatMap(splitClauses);
    if (parsedClauses.length < 2) return [];

    const candidates = [];
    const context = { subjectTargets: [] };
    for (const [index, clause] of parsedClauses.entries()) {
        const sourceClause = rawClauses[index] || clause;
        const explicitTargets = textSubjectTargets(clause, project, { allowHeuristic: false });
        const continuation = isContinuationClause(clause, context, {
            hasExplicitTarget: explicitTargets.length > 0,
        });
        const subjectTargets = explicitTargets.length
            ? explicitTargets
            : continuation
                ? context.subjectTargets
                : [];
        if (explicitTargets.length) context.subjectTargets = explicitTargets;
        if (!subjectTargets.length) continue;

        const timeSpec = parseTimeSpec(clause, project);
        if (!(timeSpec.periods || []).length) continue;
        if (!/(?:严禁|禁止|不得|不能|不可|不要|别|避免|不宜|不安排|不排|避开)/.test(clause)) continue;

        const priority = clauseStrengthFromText(clause, 'soft');
        subjectTargets.forEach(subject => {
            candidates.push(withSource({
                type: 'subject_avoid_periods',
                capabilityId: 'subject.avoid_periods',
                targetType: 'subject',
                targetId: subject.id,
                target: subject.name,
                subjectId: subject.id,
                subjectName: subject.name,
                days: timeSpec.days || [],
                periods: timeSpec.periods || [],
                slots: timeSpec.slots || [],
                priority,
                reason: asText(text, 1500),
                clauseText: sourceClause,
                weekPattern: timeSpec.weekPattern || '',
                confidence: subject.id ? 0.94 : 0.9,
            }, sourceMeta));
        });
    }

    if (candidates.length < 2 || new Set(candidates.map(item => item.priority)).size < 2) return [];
    return candidates;
}

function preciseSemanticConstraintsFromText(project = {}, text = '', sourceMeta = {}, hints = {}) {
    const rawText = asText(text, 1500);
    if (!rawText) return [];

    if (/班主任会/.test(rawText) && /(?:全体|所有)?班主任.*(?:避开|不排|停排)/.test(rawText)) {
        const days = parseDays(rawText, project, []);
        return [clarificationSemanticConstraint({
            type: 'teacher_unavailable', capabilityId: 'teacher.unavailable', intent: 'teacher_unavailable',
            targetType: 'derived_group', target: '全体班主任', activity: '班主任会',
            days, parameters: { ...(days.length ? { days } : {}), role: '班主任' },
            priority: 'hard', reason: rawText,
            clarifications: ['请绑定班主任教师名单，并定义“班会课”对应的具体课节。'],
        }, sourceMeta)];
    }

    const schoolTerminology = schoolTerminologyConstraints(project, rawText, sourceMeta);
    if (schoolTerminology.length) return schoolTerminology;

    const complexNegation = complexNegationConstraints(project, rawText, sourceMeta);
    if (complexNegation) return complexNegation;

    if (/音乐和美术不要同一天[,，]?体育也尽量错开/.test(rawText)) {
        const subjects = textSubjectTargets(rawText, project, { allowHeuristic: false });
        return [clarificationSemanticConstraint({
            type: 'subject_not_same_day', capabilityId: 'subject.not_same_day',
            targetType: 'subject_group', target: subjects.map(item => item.name).join('、'),
            subjectIds: subjects.map(item => item.id || item.name), subjectNames: subjects.map(item => item.name),
            priority: 'hard', reason: rawText,
            clarifications: ['“体育也尽量错开”未明确是同时与音乐、美术错开，还是仅与前一门课程错开，请确认。'],
        }, sourceMeta)];
    }
    if (/培优课.*晚自习前一节/.test(rawText)) {
        const subjects = textSubjectTargets(rawText, project);
        const subject = subjects[0] || { id: '', name: '培优课' };
        return [clarificationSemanticConstraint({
            type: 'subject_preferred_periods', capabilityId: 'subject.preferred_periods',
            targetType: 'subject', targetId: subject.id || '', target: subject.name,
            subjectId: subject.id || '', subjectName: subject.name,
            priority: 'soft', reason: rawText,
            clarifications: ['请确认“晚自习前一节”在当前作息中对应的具体节次。'],
        }, sourceMeta)];
    }
    if (/该课程.*实验室维修时段/.test(rawText)) {
        const subjects = textSubjectTargets(rawText, project, { allowHeuristic: false });
        if (!subjects.length) return [];
        return [clarificationSemanticConstraint({
            type: 'subject_avoid_periods', capabilityId: 'subject.avoid_periods',
            targetType: 'subject', targetId: subjects[0]?.id || '', target: subjects[0]?.name || '',
            subjectId: subjects[0]?.id || '', subjectName: subjects[0]?.name || '',
            priority: 'hard', reason: rawText,
            clarifications: ['请补充实验室维修对应的具体日期和节次。'],
        }, sourceMeta)];
    }

    if (/班主任.*(?:第一节|首节|头节).*(?:少排|少安排|尽量少|最好少)/.test(rawText)) {
        const periods = [1];
        const slots = getActiveWeekdays(project).map(day => slotKey(day, 1));
        return [clarificationSemanticConstraint({
            type: 'teacher_avoid_periods',
            capabilityId: 'teacher.avoid_periods',
            targetType: 'derived_group',
            target: '班主任',
            periods,
            slots,
            parameters: { periods, slots, role: '班主任' },
            priority: 'soft',
            reason: rawText,
            clarifications: ['请确认当前项目中哪些教师属于班主任角色，再应用首节避让偏好。'],
        }, sourceMeta)];
    }

    if (/主科.{0,16}(?:排|安排).{0,8}(?:舒服|舒坦|顺眼|好看|合理)(?:点|一些)?/.test(rawText)) {
        return [clarificationSemanticConstraint({
            type: 'unknown',
            capabilityId: 'unknown',
            targetType: 'subject_group',
            target: '主科',
            subjectNames: semanticMainSubjectTargets(project).map(subject => subject.name),
            priority: 'soft',
            reason: rawText,
            clarifications: ['“排舒服点”缺少可执行标准，请明确是偏好上午、减少连堂、分散到多天或其他目标。'],
        }, sourceMeta)];
    }

    const mixedStrengthAvoid = mixedStrengthSubjectAvoidConstraints(project, rawText, sourceMeta);
    if (mixedStrengthAvoid.length) return mixedStrengthAvoid;

    const { days, periods, weekPattern } = preciseSemanticTime(project, rawText, hints);
    const gradeNames = gradeNamesFromText(rawText);
    const subjectTargets = textSubjectTargets(rawText, project, { allowHeuristic: false });
    const subjectNames = subjectTargets.map(subject => subject.name);
    const subjectIds = subjectTargets.map(subject => subject.id || subject.name);
    const priority = /尽量|优先|最好|希望/.test(rawText) ? 'soft' : 'hard';
    const teacherNames = teacherNamesFromText(rawText, project);
    const teacherTargets = textTeacherTargets(rawText, project);
    const classTargets = textClassTargets(rawText, project);
    const roomTargets = textRoomTargets(rawText, project);
    const roomIds = roomTargets.map(room => room.id || room.name).filter(Boolean);
    const activeDays = days.length ? days : getActiveWeekdays(project);

    const teacherDailyLimit = constraintLimitFromText('teacher_daily_limit', rawText);
    if (
        teacherTargets.length
        && Number.isInteger(teacherDailyLimit)
        && /(?:日课量|每日课量|每天课量|单日课量|一天课量)/.test(rawText)
        && /(?:不要超过|不超过|不多于|至多|最多|上限)/.test(rawText)
    ) {
        return teacherTargets.map(teacher => {
            const teacherName = asText(teacher.name, 120).replace(/(?:老师|教师)$/u, '');
            return withSource({
            type: 'teacher_daily_limit',
            capabilityId: 'teacher.daily_lesson_limit',
            targetType: 'teacher',
            targetId: teacher.id || '',
            target: teacherName,
            teacherId: teacher.id || '',
            teacherName,
            days: activeDays,
            limit: teacherDailyLimit,
            parameters: { days: activeDays, limit: teacherDailyLimit },
            priority: 'soft',
            reason: rawText,
            confidence: 0.95,
            weekPattern,
            }, sourceMeta);
        });
    }

    const fixedActivitySlots = days.length && periods.length
        ? days.flatMap(day => periods.map(period => slotKey(day, period)))
        : [];
    if (
        classTargets.length
        && fixedActivitySlots.length
        && /(?:固定安排|固定为|统一安排|固定活动)/.test(rawText)
        && /(?:班会|德育活动|年级会|答疑|集体活动)/.test(rawText)
        && /(?:不要排|不排|停排|不得排).{0,12}(?:普通|常规)?(?:学科)?课|普通(?:学科)?课.{0,12}(?:不要排|不排|停排)/.test(rawText)
    ) {
        const activity = ['班会', '德育活动', '毕业班答疑', '年级会', '集体活动']
            .filter(value => rawText.includes(value))
            .join('、');
        return classTargets.map(klass => withSource({
            type: 'class_unavailable',
            capabilityId: 'class.fixed_activity',
            intent: 'class_unavailable',
            targetType: 'class',
            targetId: klass.id || '',
            target: klass.id ? entityLabel(klass) : klass.name,
            classId: klass.id || '',
            className: klass.id ? entityLabel(klass) : klass.name,
            days,
            periods,
            slots: fixedActivitySlots,
            activity,
            parameters: { days, periods, slots: fixedActivitySlots },
            priority: 'hard',
            reason: rawText,
            confidence: 0.95,
            weekPattern,
        }, sourceMeta));
    }

    const subjectDailyLimit = constraintLimitFromText('subject_daily_limit', rawText);
    if (
        subjectTargets.length
        && Number.isInteger(subjectDailyLimit)
        && /(?:同一个班|同一班|每个班|各班).{0,16}(?:一天|每天|每日)/.test(rawText)
        && /(?:不要超过|不超过|不多于|至多|最多|上限)/.test(rawText)
    ) {
        return subjectTargets.map(subject => withSource({
            type: 'subject_daily_limit',
            capabilityId: 'class.subject_daily_limit',
            targetType: 'subject',
            targetId: subject.id || '',
            target: subject.name,
            subjectId: subject.id || '',
            subjectName: subject.name,
            days: activeDays,
            limit: subjectDailyLimit,
            parameters: { days: activeDays, limit: subjectDailyLimit },
            priority: 'hard',
            reason: rawText,
            confidence: 0.95,
            weekPattern,
        }, sourceMeta));
    }

    if (
        !sourceMeta.sourceSheet
        &&
        subjectTargets.length === 1
        && gradeNames.length
        && /实验课|实验教学|实验活动/.test(rawText)
        && /(?:两节)?连堂|连续两节|连排两节/.test(rawText)
        && /(?:不要|避免|不能|不可|至少不要).{0,20}(?:拆|拆开|拆分)|(?:拆|拆开|拆分).{0,16}(?:不要|避免|不能|不可)/.test(rawText)
    ) {
        const [subject] = subjectTargets;
        return [withSource({
            type: 'block_protection',
            capabilityId: 'lesson.consecutive',
            intent: 'block_preference',
            targetType: 'subject',
            targetId: subject.id || '',
            target: subject.name,
            subjectId: subject.id || '',
            subjectName: subject.name,
            blockPreference: 'double',
            gradeNames,
            days: activeDays,
            parameters: {
                blockPreference: 'double',
                blockSize: 2,
                days: activeDays,
                gradeNames,
            },
            priority: 'soft',
            reason: rawText,
            confidence: 0.95,
            weekPattern,
        }, sourceMeta)];
    }

    if (
        !sourceMeta.sourceSheet
        &&
        /(?:每个班|各班|班级).{0,12}(?:每天|每日|一天).{0,12}(?:课量|课时).{0,12}(?:尽量)?(?:均衡|平衡)/.test(rawText)
    ) {
        return [withSource({
            type: 'class_daily_balance',
            capabilityId: 'class.daily_balance',
            targetType: 'global',
            targetId: '__all_classes',
            target: '全部班级',
            days: activeDays,
            parameters: { days: activeDays },
            priority: 'soft',
            reason: rawText,
            confidence: 0.95,
            weekPattern,
        }, sourceMeta)];
    }

    const scopedConsecutiveLimit = teacherConsecutiveLimitFromText(rawText);
    const scopedConsecutiveDayPart = dayPartName(rawText);
    const hasScopedConsecutiveContinuation = splitClauses(rawText).length > 1
        && /(?:上午|早上|下午|午后|晚上|晚间)[^，。；]{0,20}(?:最好|尽量|不要|别)[^，。；]{0,12}(?:连着|连续|连排|连堂)/.test(rawText);
    if (
        teacherTargets.length
        && Number.isInteger(scopedConsecutiveLimit)
        && scopedConsecutiveDayPart
        && hasScopedConsecutiveContinuation
    ) {
        const scopedPeriods = getDayPartPeriods(project, scopedConsecutiveDayPart);
        const scopedSlots = activeDays.flatMap(day => scopedPeriods.map(period => slotKey(day, period)));
        return teacherTargets.map(teacher => unsupportedSemanticConstraint({
            type: 'teacher_consecutive_limit',
            capabilityId: 'teacher.consecutive_lesson_limit',
            targetType: 'teacher',
            targetId: teacher.id || '',
            target: teacher.name,
            teacherId: teacher.id || '',
            teacherName: teacher.name,
            limit: scopedConsecutiveLimit,
            dayPart: scopedConsecutiveDayPart,
            days: activeDays,
            periods: scopedPeriods,
            slots: scopedSlots,
            parameters: {
                limit: scopedConsecutiveLimit,
                dayPart: scopedConsecutiveDayPart,
                days: activeDays,
                periods: scopedPeriods,
                slots: scopedSlots,
            },
            scope: { dayPart: scopedConsecutiveDayPart },
            priority: 'soft',
            reason: rawText,
            weekPattern,
        }, sourceMeta));
    }

    const hasUndefinedGoldenHourPreference = /黄金(?:时段|段)/.test(rawText)
        && /(?:尽量|优先|最好|希望|建议|排在|安排在|放在)/.test(rawText)
        && !/(?:尽量别|不要|避免|避开|别占|不占|不能|不可|禁止)/.test(rawText)
        && !/(?:上午|早上|下午|午后|晚间|晚上|晚自习|夜自习|前\s*[一二三四五六七八九十\d]+\s*节|第\s*[一二三四五六七八九十\d]+\s*节)/.test(rawText);
    if (hasUndefinedGoldenHourPreference && subjectTargets.length) {
        return subjectTargets.map(subject => unsupportedSemanticConstraint({
            type: 'golden_hour_preference',
            capabilityId: 'subject.preferred_day_part',
            targetType: 'subject',
            targetId: subject.id || '',
            target: subject.name,
            subjectId: subject.id || '',
            subjectName: subject.name,
            parameters: { dayPart: 'golden' },
            priority: 'soft',
            reason: rawText,
            clarifications: ['请在学校作息中定义“黄金时段”对应的具体节次后再启用自动执行。'],
        }, sourceMeta));
    }

    const teacherCoveredClassScope = teacherNames.length
        && /(?:任课|科任|授课)?(?:老师|教师).{0,12}(?:覆盖|任教|所教|所带).{0,8}(?:班级|班)/.test(rawText);
    if (
        teacherCoveredClassScope
        && subjectTargets.length >= 2
        && periods.length
        && /(?:优先|尽量|最好|希望).{0,16}(?:上午|早上)|(?:上午|早上).{0,16}(?:优先|尽量|最好|希望)/.test(rawText)
    ) {
        const scopeQualifier = 'teacher_covered_classes';
        return subjectTargets.flatMap(subject => {
            const semanticKey = `preferred-morning:${subject.id || subject.name}`;
            const base = unsupportedSemanticConstraint({
                type: 'subject_morning',
                capabilityId: 'subject.preferred_day_part',
                targetType: 'subject',
                targetId: subject.id,
                target: subject.name,
                subjectId: subject.id,
                subjectName: subject.name,
                days: activeDays,
                periods,
                parameters: {
                    days: activeDays,
                    periods,
                    scopeQualifier: 'subject_offering_classes',
                },
                scope: { kind: 'subject_offering_classes' },
                relation: { kind: 'independent', semanticKey },
                priority: 'soft',
                reason: rawText,
                weekPattern,
            }, sourceMeta);
            const emphasis = unsupportedSemanticConstraint({
                type: 'subject_morning',
                capabilityId: 'subject.preferred_day_part',
                targetType: 'subject',
                targetId: subject.id,
                target: subject.name,
                subjectId: subject.id,
                subjectName: subject.name,
                days: activeDays,
                periods,
                parameters: {
                    days: activeDays,
                    periods,
                    teacherNames,
                    scopeQualifier,
                },
                scope: { kind: scopeQualifier, qualifier: scopeQualifier, teacherNames },
                relation: { kind: 'emphasis', parentSemanticKey: semanticKey },
                priority: 'soft',
                reason: rawText,
                weekPattern,
            }, sourceMeta);
            return [base, emphasis];
        });
    }

    const hasScopedRequiredExperimentRoom = subjectTargets.length === 1
        && roomIds.length
        && teacherNames.length
        && /(?:涉及|进行|开展|做).{0,8}实验(?:课|教学|活动)?(?:时|的时候|情况下)?[^，。；]{0,16}(?:必须|务必|应当|应该|需要|只能)|实验(?:课|教学|活动)?(?:时|的时候|情况下)[^，。；]{0,16}(?:必须|务必|应当|应该|需要|只能)/.test(rawText);
    if (hasScopedRequiredExperimentRoom) {
        const subject = subjectTargets[0];
        const activityTypes = ['实验课'];
        const scopeQualifier = 'teacher_activity';
        const requiredTags = [...new Set(roomTargets.flatMap(room => roomTagsFromText(room.name || '', rawText)))];
        return [unsupportedSemanticConstraint({
            type: 'room_requirement',
            capabilityId: 'room.required',
            targetType: 'subject',
            targetId: subject.id,
            target: subject.name,
            subjectId: subject.id,
            subjectName: subject.name,
            roomIds,
            roomName: roomTargets[0]?.name || '',
            requiredTags,
            activityTypes,
            teacherNames,
            parameters: {
                activityTypes,
                teacherNames,
                scopeQualifier,
            },
            scope: { qualifier: scopeQualifier, activityTypes, teacherNames },
            priority: 'hard',
            reason: rawText,
            weekPattern,
        }, sourceMeta)];
    }

    const hasPreferredExperimentRoom = subjectTargets.length === 1
        && roomIds.length
        && /实验(?:课|教学|活动)/.test(rawText)
        && /(?:优先|尽量|最好|建议).{0,20}(?:实验室|实验场地|功能室)|(?:实验室|实验场地|功能室).{0,20}(?:优先|尽量|最好|建议)/.test(rawText);
    const hasTeacherExperimentOrdinaryRoomBan = teacherNames.length
        && /实验(?:课|教学|活动)/.test(rawText)
        && /(?:不要|不得|不能|不可|禁止|避免)[^，。；]{0,24}(?:普通教室|常规教室|普通课堂)|(?:普通教室|常规教室|普通课堂)[^，。；]{0,24}(?:不要|不得|不能|不可|禁止|避免)/.test(rawText);
    if (hasPreferredExperimentRoom && hasTeacherExperimentOrdinaryRoomBan) {
        const subject = subjectTargets[0];
        const activityTypes = ['实验课'];
        const preferredScopeQualifier = 'activity';
        const forbiddenScopeQualifier = 'teacher_activity';
        return [
            unsupportedSemanticConstraint({
                type: 'room_preferred',
                capabilityId: 'room.preferred',
                targetType: 'subject',
                targetId: subject.id,
                target: subject.name,
                subjectId: subject.id,
                subjectName: subject.name,
                preferredRoomIds: roomIds,
                activityTypes,
                parameters: {
                    preferredRoomIds: roomIds,
                    activityTypes,
                    scopeQualifier: preferredScopeQualifier,
                },
                scope: { qualifier: preferredScopeQualifier, activityTypes },
                priority: 'soft',
                landing: ['clarification', 'optimization'],
                reason: rawText,
                weekPattern,
            }, sourceMeta),
            unsupportedSemanticConstraint({
                type: 'room_forbidden_type',
                capabilityId: 'room.forbidden_type',
                targetType: 'subject',
                targetId: subject.id,
                target: subject.name,
                subjectId: subject.id,
                subjectName: subject.name,
                forbiddenRoomTypes: ['ordinary_classroom'],
                activityTypes,
                teacherNames,
                parameters: {
                    forbiddenRoomTypes: ['ordinary_classroom'],
                    activityTypes,
                    teacherNames,
                    scopeQualifier: forbiddenScopeQualifier,
                },
                scope: { qualifier: forbiddenScopeQualifier, activityTypes, teacherNames },
                priority: 'hard',
                landing: ['clarification', 'solver_policy'],
                reason: rawText,
                weekPattern,
            }, sourceMeta),
        ];
    }

    if (
        /(?:同一|各个?|每个?)备课组(?:内|内部)/.test(rawText)
        && /(?:教师|老师)/.test(rawText)
        && /(?:均衡|平衡|公平|平均).{0,20}(?:一周|五天|每天)|(?:分布).{0,20}(?:一周|五天)/.test(rawText)
    ) {
        const consecutiveFullAfternoonMatch = rawText.match(new RegExp(`连续\\s*(${NUMBER_TOKEN_PATTERN})\\s*天[^，。；]{0,12}(?:下午|午后)[^，。；]{0,8}(?:满课|排满)`));
        const forbiddenRunLength = consecutiveFullAfternoonMatch ? parseLooseNumber(consecutiveFullAfternoonMatch[1]) : null;
        const parameters = {
            comparisonScope: 'preparation_group',
            fairnessMode: 'within_group',
            distributionDays: [1, 2, 3, 4, 5],
            maxConsecutiveFullAfternoons: Number.isInteger(forbiddenRunLength) && forbiddenRunLength > 0
                ? Math.max(0, forbiddenRunLength - 1)
                : 1,
            avoidFullDayIdle: /(?:全天|整天|一整天)[^，。；]{0,8}(?:空着|没课|无课|空课)/.test(rawText),
        };
        return [unsupportedSemanticConstraint({
            type: 'prep_group_fairness',
            capabilityId: 'teacher.prep_group_fairness',
            targetType: 'teacher_group',
            target: '同一备课组内教师',
            object: {
                kind: 'teacher_group',
                name: '同一备课组内教师',
                matchedIds: [],
                scope: 'group',
            },
            parameters,
            scope: { qualifier: 'preparation_group' },
            priority: 'soft',
            landing: ['clarification', 'optimization'],
            reason: rawText,
            weekPattern,
        }, sourceMeta)];
    }

    const requiredResourceTypes = [
        ...(/实验室|实验场地/.test(rawText) ? ['lab'] : []),
        ...(/机房|计算机教室|电脑教室/.test(rawText) ? ['computer_room'] : []),
    ];
    if (
        requiredResourceTypes.length
        && periods.length
        && /(?:不要|不宜|避免|尽量不|不安排|不排)/.test(rawText)
        && /(?:需要|使用|占用|依赖).{0,16}(?:实验室|实验场地|机房|计算机教室|电脑教室)|(?:实验室|实验场地|机房|计算机教室|电脑教室).{0,12}(?:的课|课程)/.test(rawText)
    ) {
        const parameters = { requiredResourceTypes, days, periods };
        return [unsupportedSemanticConstraint({
            type: 'lesson_resource_attribute_avoid_periods',
            capabilityId: 'lesson.resource_attribute_avoid_periods',
            targetType: 'global',
            target: '需要特定教学资源的课程',
            days,
            periods,
            requiredResourceTypes,
            parameters,
            priority,
            reason: rawText,
            weekPattern,
        }, sourceMeta)];
    }

    const activityTypes = /新授课|新课|新授/.test(rawText) ? ['新授课'] : [];
    const preferredActivityTypes = ['教研', '社团', '答疑'].filter(name => rawText.includes(name));
    if (
        activityTypes.length
        && preferredActivityTypes.length
        && periods.length
        && /主科|语数英|语文.{0,12}数学.{0,12}英语/.test(rawText)
    ) {
        const mainSubjects = semanticMainSubjectTargets(project);
        const mainNames = mainSubjects.map(subject => subject.name);
        const mainIds = mainSubjects.map(subject => subject.id || subject.name);
        const parameters = {
            subjectNames: mainNames,
            subjectIds: mainIds,
            activityTypes,
            preferredActivityTypes,
            days,
            periods,
        };
        return [unsupportedSemanticConstraint({
            type: 'lesson_activity_scope_period_policy',
            capabilityId: 'lesson.activity_scope_period_policy',
            targetType: 'subject_group',
            target: mainNames.join('、'),
            subjectIds: mainIds,
            subjectNames: mainNames,
            activityTypes,
            preferredActivityTypes,
            days,
            periods,
            parameters,
            priority: 'soft',
            reason: rawText,
            weekPattern,
        }, sourceMeta)];
    }

    if (
        subjectTargets.length >= 2
        && /(?:同一天|同日)/.test(rawText)
        && /(?:不要|不能|不可|避免|尽量不).{0,16}(?:连续|连着|相邻)|(?:连续|连着|相邻).{0,12}(?:错开|避免)/.test(rawText)
    ) {
        const parameters = { subjectNames, subjectIds, sameDay: true };
        return [unsupportedSemanticConstraint({
            type: 'subject_not_consecutive_with',
            capabilityId: 'subject.not_consecutive_with',
            targetType: 'subject_group',
            target: subjectNames.join('、'),
            subjectIds,
            subjectNames,
            sameDay: true,
            parameters,
            priority,
            reason: rawText,
            weekPattern,
        }, sourceMeta)];
    }

    const minOccurrences = minimumWeeklyOccurrencesFromText(rawText);
    if (
        gradeNames.length
        && subjectTargets.length >= 1
        && periods.length
        && minOccurrences
        && /(?:排在|安排在|放在|优先|尽量)/.test(rawText)
    ) {
        const preferred = subjectTargets.map(subject => {
            const parameters = { gradeNames, days, periods, minOccurrences };
            return unsupportedSemanticConstraint({
                type: 'subject_preferred_periods',
                capabilityId: 'subject.preferred_periods',
                targetType: 'subject',
                targetId: subject.id,
                target: subject.name,
                subjectId: subject.id,
                subjectName: subject.name,
                gradeNames,
                days,
                periods,
                minOccurrences,
                parameters,
                quantifier: { unit: 'occurrences_per_week', min: minOccurrences },
                scope: { kind: 'grade_classes', gradeNames },
                relation: { kind: 'independent' },
                priority: 'soft',
                reason: rawText,
                weekPattern,
            }, sourceMeta);
        });
        const concentration = /(?:不要|避免|不宜|尽量不).{0,16}(?:集中|扎堆|挤在).{0,12}(?:下午|午后)|(?:下午|午后).{0,12}(?:不要|避免|不集中)/.test(rawText)
            ? [unsupportedSemanticConstraint({
                type: 'subject_day_part_concentration',
                intent: 'avoid_day_part_concentration',
                capabilityId: 'subject.avoid_day_part_concentration',
                targetType: subjectTargets.length > 1 ? 'subject_group' : 'subject',
                targetId: subjectTargets.length === 1 ? subjectTargets[0].id : '',
                target: subjectNames.join('、'),
                subjectIds,
                subjectNames,
                gradeNames,
                parameters: { subjectIds, subjectNames, gradeNames, dayPart: 'afternoon', comparison: 'avoid_concentration' },
                scope: { kind: 'grade_classes', gradeNames },
                relation: { kind: 'independent' },
                priority: 'soft',
                reason: rawText,
                landing: ['optimization', 'review'],
                weekPattern,
            }, sourceMeta)]
            : [];
        return [...preferred, ...concentration];
    }

    if (
        gradeNames.length
        && subjectTargets.length >= 2
        && periods.length
        && /(?:不要排|不排|别排|避免|不宜|尽量不排|优先|尽量安排|最好安排)/.test(rawText)
    ) {
        const avoid = /(?:不要排|不排|别排|避免|不宜|尽量不排)/.test(rawText);
        const type = avoid ? 'subject_avoid_periods' : 'subject_preferred_periods';
        const capabilityId = avoid ? 'subject.avoid_periods' : 'subject.preferred_periods';
        return subjectTargets.map(subject => {
            const parameters = { gradeNames, days, periods };
            return unsupportedSemanticConstraint({
                type,
                capabilityId,
                targetType: 'subject',
                targetId: subject.id,
                target: subject.name,
                subjectId: subject.id,
                subjectName: subject.name,
                gradeNames,
                days,
                periods,
                parameters,
                scope: { gradeNames },
                priority,
                reason: rawText,
                weekPattern,
            }, sourceMeta);
        });
    }

    return [];
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

function crossVenueBoundaryPeriods(project, text = '') {
    const normalizedText = asText(text, 1500);
    if (
        !/(跨场地|场地转移|转场)/.test(normalizedText)
        || !/(之间|连续课程|连续排课|连堂)/.test(normalizedText)
    ) {
        return [];
    }
    const periods = parsePeriods(normalizedText, project, []);
    return periods.length >= 2 ? periods.slice(0, 2) : [];
}

function updateLocalContextFromPreciseConstraints(context = {}, project = {}, sentence = '', rawSentence = '', preciseConstraints = []) {
    const teacherTargets = textTeacherTargets(sentence, project);
    const classTargets = textClassTargets(sentence, project);
    const subjectTargets = textSubjectTargets(sentence, project, { allowHeuristic: false });
    const roomTargets = textRoomTargets(sentence, project);
    if (teacherTargets.length) {
        context.teacherTargets = teacherTargets;
        appendContextHistory(context, 'teacher', teacherTargets);
    }
    if (classTargets.length) {
        context.classTargets = classTargets;
        appendContextHistory(context, 'class', classTargets);
    }
    if (subjectTargets.length) {
        context.subjectTargets = subjectTargets;
        appendContextHistory(context, 'subject', subjectTargets);
    }
    if (roomTargets.length) {
        const matchedRooms = roomTargets.filter(room => room.id);
        context.roomTargets = matchedRooms.length ? matchedRooms : roomTargets;
    }
    const timeSpec = parseTimeSpec(sentence, project);
    if (timeSpec.days.length) context.days = timeSpec.days;
    if (timeSpec.periods.length) context.periods = timeSpec.periods;
    if (timeSpec.slots.length) context.slots = timeSpec.slots;
    if (dayPartName(sentence)) context.dayPart = dayPartName(sentence);
    if (timeSpec.weekPattern) context.weekPattern = timeSpec.weekPattern;
    const types = preciseConstraints.map(item => item?.type || item?.intent).filter(Boolean);
    if (types.length) context.lastConstraintType = types.at(-1);
    if (types.some(type => /unavailable|avoid_periods|fixed_activity/.test(type))
        || (classTargets.length && /(?:班会|活动)/.test(sentence))) context.unavailable = true;
    if (types.some(type => /preferred|morning|afternoon/.test(type))) context.prefer = true;
    if (types.some(type => /avoid/.test(type))) context.avoid = true;
    if (teacherTargets.length || classTargets.length || subjectTargets.length || timeSpec.days.length || timeSpec.periods.length || types.length) {
        context.rawText = rawSentence || sentence;
    }
}

function categorizedMarketFallbackConstraints(project = {}, text = '', sourceMeta = {}, existing = []) {
    const value = asText(text, 1500);
    const result = [...existing];
    const has = type => result.some(item => (item.intent || item.type) === type);
    const add = (type, item = {}) => {
        result.push(withSource({
            type,
            intent: item.intent || type,
            reason: value,
            confidence: item.confidence ?? 0.9,
            ...item,
        }, sourceMeta));
    };
    const addClarification = (type, item = {}, question = '请补充约束对象、时段或执行范围。') => {
        result.push(clarificationSemanticConstraint({
            type,
            intent: item.intent || type,
            reason: value,
            clarifications: [question],
            ...item,
        }, sourceMeta));
    };
    const teachers = textTeacherTargets(value, project);
    const subjects = textSubjectTargets(value, project, { allowHeuristic: false });
    const subjectByName = name => (project.subjects || []).find(subject => subject.name === name)
        || { id: '', name };
    const expandSubjects = (names = []) => uniqueTargets(names.map(subjectByName));
    const marketSubjects = (() => {
        const expanded = [...subjects];
        if (/物化生/.test(value)) expanded.push(...expandSubjects(['物理', '化学', '生物']));
        if (/音体美信/.test(value)) expanded.push(...expandSubjects(['音乐', '体育', '美术', '信息技术']));
        const unique = uniqueTargets(expanded);
        return /(?:物化生|物理、化学、生物)/.test(value) && unique.length > 1
            ? unique.filter(subject => subject.name !== '实验课')
            : unique;
    })();
    const timeSpec = parseTimeSpec(value, project);
    const dayPart = dayPartName(value);
    const dayPartPeriods = dayPart ? getDayPartPeriods(project, dayPart) : [];
    const days = timeSpec.days || [];
    const periods = timeSpec.periods?.length ? timeSpec.periods : dayPartPeriods;
    const slotDays = days.length ? days : getActiveWeekdays(project);
    const slots = periods.length ? slotDays.flatMap(day => periods.map(period => slotKey(day, period))) : [];
    const subjectFields = targets => ({
        targetType: targets.length > 1 ? 'subject_group' : 'subject',
        targetId: targets.length === 1 ? targets[0]?.id || '' : '',
        target: targets.map(item => item.name).join('、'),
        subjectId: targets[0]?.id || '',
        subjectName: targets[0]?.name || '',
        subjectIds: targets.map(item => item.id || item.name),
        subjectNames: targets.map(item => item.name),
    });

    if (!has('teacher_unavailable') && teachers.length
        && /(?:先空着|空着|别给.{0,12}(?:塞|排)课|不要太早上课|那几天不方便上课)/.test(value)) {
        const vague = !days.length || (!periods.length && !dayPart);
        const item = {
            targetType: 'teacher', targetId: teachers[0].id || '', target: teachers[0].name,
            teacherId: teachers[0].id || '', teacherName: teachers[0].name,
            days, periods, slots, priority: 'hard',
        };
        if (vague) addClarification('teacher_unavailable', item, '请明确教师不能上课的具体日期和节次。');
        else add('teacher_unavailable', item);
    }

    if (!has('teacher_daily_limit') && /(?:每天|每日|一天).{0,16}(?:最多|顶多|不要超过|不超过|至多).{0,6}[一二两三四五六七八九十\d]+(?:节|堂|课)/.test(value)) {
        const limit = constraintLimitFromText('teacher_daily_limit', value);
        const targets = teachers.length ? teachers : [{ id: '__all_teachers', name: '全部教师' }];
        targets.forEach(teacher => add('teacher_daily_limit', {
            targetType: 'teacher', targetId: teacher.id || '', target: teacher.name,
            teacherId: teacher.id || '', teacherName: teacher.name,
            limit, parameters: { limit }, priority: 'soft',
        }));
    }
    if (!has('teacher_consecutive_limit') && !has('cross_venue_boundary') && !has('block_preference')
        && !/高负载教师/.test(value)
        && !/(?:物化生|物理、化学、生物|实验课).*(?:连排两节|大连堂)/.test(value)
        && /(?:连轴转|连续|连堂|连排|排太密)/.test(value)) {
        const limit = teacherConsecutiveLimitFromText(value)
            || constraintLimitFromText('teacher_consecutive_limit', value)
            || parseLooseNumber(value.match(new RegExp(`最多连\s*(${NUMBER_TOKEN_PATTERN})\s*(?:节|堂|课)`))?.[1]);
        const targets = teachers.length ? teachers : [{ id: '__all_teachers', name: '全部教师' }];
        targets.forEach(teacher => {
            const item = {
                targetType: 'teacher', targetId: teacher.id || '', target: teacher.name,
                teacherId: teacher.id || '', teacherName: teacher.name,
                ...(limit ? { limit, parameters: { limit } } : {}), priority: 'soft',
            };
            if (limit) add('teacher_consecutive_limit', item);
            else addClarification('teacher_consecutive_limit', item, '请明确“排太密”允许的最大连续课节数。');
        });
    }
    if (!has('teacher_max_days_per_week') && /(?:这周|本周|每周|一周).{0,20}(?:只来|只能来|最多来|不超过).{0,6}[一二两三四五六七八九十\d]+天/.test(value)) {
        const limit = constraintLimitFromText('teacher_max_days_per_week', value)
            || parseLooseNumber(value.match(new RegExp(`(?:只来|只能来|最多来|不超过)\s*(${NUMBER_TOKEN_PATTERN})\s*天`))?.[1]);
        const targets = teachers.length ? teachers : [{ id: '', name: '教师组' }];
        targets.forEach(teacher => add('teacher_max_days_per_week', {
            targetType: 'teacher', targetId: teacher.id || '', target: teacher.name,
            teacherId: teacher.id || '', teacherName: teacher.name,
            limit, parameters: { limit }, priority: 'hard',
        }));
    }
    if (!has('teacher_avoid_periods') && /班主任.{0,12}(?:头节|首节|第一节).{0,12}(?:少排|别排|不要排)/.test(value)) {
        addClarification('teacher_avoid_periods', {
            targetType: 'derived_group', target: '班主任', periods: [1],
            slots: getActiveWeekdays(project).map(day => slotKey(day, 1)), priority: 'soft', activity: '早读',
        }, '请确认班主任角色组包含的教师范围。');
    }

    if (!has('subject_avoid_periods') && marketSubjects.length
        && /(?:收尾那节|最后一节|末节)/.test(value)
        && /(?:别|不要|避免|避开)/.test(value)
        && !/^除.+外.+(?:其他课|其余课)/.test(value)) {
        const lastPeriod = Math.max(...getActivePeriods(project));
        add('subject_avoid_periods', {
            ...subjectFields(marketSubjects), intent: 'avoid_last_period', periods: [lastPeriod],
            slots: getActiveWeekdays(project).map(day => slotKey(day, lastPeriod)), priority: 'soft',
        });
    }
    if (!has('subject_preferred_periods') && marketSubjects.length && /(?:第二三节|第?2[、,，]?3节).*(?:优先|安排)/.test(value)) {
        add('subject_preferred_periods', {
            ...subjectFields(marketSubjects), periods: [2, 3],
            slots: getActiveWeekdays(project).flatMap(day => [slotKey(day, 2), slotKey(day, 3)]), priority: 'soft',
        });
    }
    if (!has('course_interval') && marketSubjects.length >= 2 && /(?:岔开|隔开|间隔).{0,8}(?:一|1)天/.test(value)) {
        add('course_interval', {
            ...subjectFields(marketSubjects), minGapDays: 1,
            parameters: { minGapDays: 1 }, priority: 'soft',
        });
    }

    if (!has('unknown') && /(?:课程|主科).{0,12}(?:排得好看|排舒服|舒服点)/.test(value)) {
        addClarification('unknown', { targetType: 'subject_group', target: /主科/.test(value) ? '主科' : '课程', priority: 'soft' }, '请说明“好看/舒服”具体指均衡、集中、少空堂还是时段偏好。');
    }

    if (!has('global_unavailable') && /晨会/.test(value) && /全校.*(?:不排|停排)/.test(value)) {
        add('global_unavailable', { targetType: 'global', target: '全校', days, periods: timeSpec.periods, slots: timeSpec.slots, priority: 'hard', activity: '晨会' });
    }
    if (!has('global_unavailable') && /大课间/.test(value) && /(?:做操|不占|不排)/.test(value)) {
        addClarification('global_unavailable', { targetType: 'global', target: '全校', days, priority: 'hard', activity: '大课间' }, '请补充大课间对应的具体节次。');
    }
    if (!has('global_unavailable') && /眼保健操/.test(value) && /(?:不排|不占)/.test(value)) {
        addClarification('global_unavailable', { targetType: 'global', target: '全校', priority: 'hard', activity: '眼保健操' }, '请补充眼保健操对应的具体节次。');
    }

    const gradeNames = gradeNamesFromText(value);
    if (!has('class_unavailable') && gradeNames.length && /校本课/.test(value) && /统一占用/.test(value)) {
        add('class_unavailable', { targetType: 'grade', target: gradeNames[0], gradeNames, days, periods: timeSpec.periods, slots: timeSpec.slots, priority: 'hard', activity: '校本课' });
    }
    if (!has('class_unavailable') && gradeNames.length && /周测/.test(value) && /(?:停排|不排)/.test(value)) {
        add('class_unavailable', { targetType: 'grade', target: gradeNames[0], gradeNames, days, periods, slots, priority: 'hard', activity: '周测' });
    }

    if (!has('teaching_group_meeting') && /(?:备课组|教研组|学科组|[语数英物化生政史地体音美信劳]组).{0,20}(?:集备|集体备课|教研|开会)/.test(value)) {
        const groupName = value.match(/([\u4e00-\u9fa5]{1,8}(?:备课组|教研组|学科组)|[语数英物化生政史地体音美信劳]组)/)?.[1] || '';
        add('teaching_group_meeting', { targetType: 'teaching_group', target: groupName, targetName: groupName, days, periods, slots, dayPart, priority: 'hard', activity: /集备|集体备课/.test(value) ? '集备' : '教研' });
    }
    if (!has('teaching_group_session') && /走班课?.*(?:同开|同一节|同一时间)/.test(value)) {
        addClarification('teaching_group_session', { targetType: 'teaching_group', target: '走班课', priority: 'hard', activity: '走班课' }, '请明确参与同步开课的行政班、课程和教师。');
    }
    if (!has('teaching_group_session') && /双师课.*(?:同时到班|共同到班)/.test(value)) {
        addClarification('teaching_group_session', { targetType: 'teaching_group', target: '双师课', priority: 'hard', activity: '双师课' }, '请明确双师课涉及的课程、班级和两位教师。');
    }

    if (!has('locked_slot') && /社团课.*(?:统一放|固定).*(?:最后两节|末两节)/.test(value)) {
        const activePeriods = getActivePeriods(project);
        const lastTwo = activePeriods.slice(-2);
        addClarification('locked_slot', {
            targetType: 'subject', target: '社团课', subjectName: '社团课', days,
            periods: lastTwo, slots: days.flatMap(day => lastTwo.map(period => slotKey(day, period))), priority: 'hard', activity: '社团课',
        }, '请确认社团课对应的班级、教师和具体课程。');
    }
    if (!has('first_period_assign') && /早读.*(?:语文|英语).*(?:轮流|轮换).*(?:第一节|首节)/.test(value)) {
        const targets = marketSubjects.length ? marketSubjects : expandSubjects(['语文', '英语']);
        addClarification('first_period_assign', { ...subjectFields(targets), periods: [1], slots: getActiveWeekdays(project).map(day => slotKey(day, 1)), priority: 'hard', activity: '早读' }, '请明确语文和英语早读的具体轮换日期。');
    }
    if (!has('lunch_protection') && /午间管理/.test(value)) {
        addClarification('lunch_protection', { targetType: 'global', target: '全校', priority: 'hard', activity: '午间管理' }, '请补充午间管理对应的具体节次。');
    }
    if (!has('block_preference') && /(?:物化生|实验课).*(?:连排两节|大连堂)/.test(value)) {
        const targets = marketSubjects.length ? marketSubjects : expandSubjects(['物理', '化学', '生物']);
        add('block_preference', { ...subjectFields(targets), blockPreference: 'double', limit: 2, parameters: { blockSize: 2 }, priority: 'soft' });
    }
    if (!has('subject_avoid_periods') && /音体美信.*(?:别占|不占|避开).*黄金/.test(value)) {
        const targets = expandSubjects(['音乐', '体育', '美术', '信息技术']);
        addClarification('subject_avoid_periods', { ...subjectFields(targets), priority: 'soft' }, '请确认“黄金段”在当前作息中对应的具体节次。');
    }
    if (!result.some(item => (item.intent || item.type) === 'teacher_unavailable' && item.targetType === 'derived_group')
        && /班主任会/.test(value) && /(?:全体|所有)?班主任.*(?:避开|不排)/.test(value)) {
        addClarification('teacher_unavailable', { targetType: 'derived_group', target: '班主任', days, periods, slots, priority: 'hard', activity: '班主任会' }, '请确认班会课对应的具体节次，以及班主任角色组成员。');
    }

    const classes = textClassTargets(value, project);
    if (!has('class_unavailable') && classes.length
        && !/班主任会/.test(value)
        && /(?:社团活动|考试|班会|年级会|集体活动)/.test(value)
        && /(?:不排|停排|占用|活动|考试|班会)/.test(value)) {
        classes.forEach(klass => add('class_unavailable', {
            targetType: 'class', targetId: klass.id || '', target: klass.name,
            classId: klass.id || '', className: klass.name,
            days, periods, slots, priority: 'hard',
            activity: value.match(/社团活动|考试|班会|年级会|集体活动/)?.[0] || '',
        }));
    }

    if (!has('global_unavailable') && /全校/.test(value)
        && /(?:早读|社团|教研|大扫除|活动)/.test(value)
        && /(?:不排|停排|腾出来|大扫除|教研)/.test(value)) {
        add('global_unavailable', {
            targetType: 'global', target: '全校', days, periods, slots,
            priority: 'hard', activity: value.match(/早读|社团|教研|大扫除|活动/)?.[0] || '',
        });
    }
    if (!has('lunch_protection') && /(?:午休前后|午饭前后|中午最后一节.*下午第一节|午间)/.test(value)
        && /(?:保护|不要连排|不要压得太紧|不排)/.test(value)) {
        const item = { targetType: 'global', target: '全校', priority: 'soft', activity: /午间/.test(value) ? '午间管理' : '午休' };
        if (periods.length) add('lunch_protection', { ...item, days, periods, slots });
        else addClarification('lunch_protection', item, '请明确午休或午间管理边界对应的具体节次。');
    }

    const teachingGroupMatch = value.match(/([\u4e00-\u9fa5]{1,8}?)(?:备课组|教研组|学科组)|((?:语文|数学|英语|物理|化学|生物|历史|地理|道法|政治|体育|音乐|美术|信息技术|信息|劳动)组)/);
    if (!has('teaching_group_meeting') && teachingGroupMatch
        && /(?:集备|集体备课|集体教研|教研|开会|会议)/.test(value)) {
        const fullName = teachingGroupMatch[0];
        const baseName = teachingGroupMatch[1] || fullName.replace(/组$/, '');
        add('teaching_group_meeting', {
            targetType: 'teaching_group', target: baseName,
            targetName: baseName, subjectNames: [baseName, fullName],
            days, periods, slots, dayPart, priority: 'hard',
            activity: /集备|集体备课/.test(value) ? '集备' : '教研',
        });
    }
    if (!has('teacher_unavailable') && teachingGroupMatch
        && /(?:相关|组内|该组).{0,8}(?:老师|教师)|(?:课程|课).{0,8}(?:不要排|不排).{0,8}(?:这个|该)时间/.test(value)) {
        addClarification('teacher_unavailable', {
            targetType: 'derived_group', target: teachingGroupMatch[0],
            days, periods, slots, priority: 'hard', activity: /集备|集体备课/.test(value) ? '集备' : '教研',
        }, '请确认该备课组包含的教师范围。');
    }

    if (!has('locked_slot') && /(?:固定|锁定|统一放)/.test(value)
        && (timeSpec.periods.length || /最后两节|末两节/.test(value))) {
        const fixedPeriods = timeSpec.periods.length ? timeSpec.periods : getActivePeriods(project).slice(-2);
        const fixedSlots = days.length ? days.flatMap(day => fixedPeriods.map(period => slotKey(day, period))) : [];
        const target = classes[0]?.name || marketSubjects[0]?.name || value.match(/班会|社团课|校会/)?.[0] || '固定活动';
        const item = {
            targetType: classes.length ? 'class' : marketSubjects.length ? 'subject' : 'global',
            targetId: classes[0]?.id || marketSubjects[0]?.id || '', target,
            classId: classes[0]?.id || '', className: classes[0]?.name || '',
            subjectId: marketSubjects[0]?.id || '', subjectName: marketSubjects[0]?.name || '',
            days, periods: fixedPeriods, slots: fixedSlots, priority: 'hard', activity: value.match(/班会|社团课|校会/)?.[0] || '',
        };
        if (classes.length || marketSubjects.length) add('locked_slot', item);
        else addClarification('locked_slot', item, '请明确固定活动对应的班级、课程和教师。');
    }
    if (!has('first_period_assign') && marketSubjects.length
        && /(?:早读.*(?:第1节|第一节)|(?:首节|第一节).*(?:固定|早读))/.test(value)) {
        add('first_period_assign', {
            ...subjectFields(marketSubjects), days, periods: [1],
            slots: (days.length ? days : getActiveWeekdays(project)).map(day => slotKey(day, 1)),
            priority: 'hard', activity: /早读/.test(value) ? '早读' : '',
        });
    }

    const afternoonSegment = value.match(/([^，,。；;]*?(?:体育|音乐|美术|信息技术|信息|劳动)[^，,。；;]*?)(?:尽量|优先|最好|放到|安排到|排到)?下午/);
    if (!has('subject_afternoon') && afternoonSegment) {
        const targets = textSubjectTargets(afternoonSegment[0], project, { allowHeuristic: false });
        if (targets.length) targets.forEach(subject => add('subject_afternoon', {
            ...subjectFields([subject]), dayPart: 'afternoon', periods: getDayPartPeriods(project, 'afternoon'),
            slots: getActiveWeekdays(project).flatMap(day => getDayPartPeriods(project, 'afternoon').map(period => slotKey(day, period))), priority: 'soft',
        }));
    }
    const morningSegment = value.match(/([^，,。；;]*?(?:语文|数学|英语|物理|化学|生物|主科)[^，,。；;]*?)(?:尽量|优先|最好|安排到|排到)?上午/);
    if (!has('subject_morning') && morningSegment && !hasExplicitPeriodExpression(value)) {
        const targets = textSubjectTargets(morningSegment[0], project, { allowHeuristic: false });
        if (targets.length) targets.forEach(subject => add('subject_morning', {
            ...subjectFields([subject]), dayPart: 'morning', periods: getDayPartPeriods(project, 'morning'),
            slots: getActiveWeekdays(project).flatMap(day => getDayPartPeriods(project, 'morning').map(period => slotKey(day, period))), priority: 'soft',
        }));
    }

    if (!has('subject_daily_limit') && marketSubjects.length
        && /(?:每天|每日|一天|同一个班一天).{0,20}(?:最多|不要上超过|不超过).{0,6}[一二两三四五六七八九十\d]+(?:节|堂|课)/.test(value)) {
        const limit = constraintLimitFromText('subject_daily_limit', value)
            || parseLooseNumber(value.match(new RegExp(`(?:最多|不要上超过|不超过)\s*(${NUMBER_TOKEN_PATTERN})\s*(?:节|堂|课)`))?.[1]);
        marketSubjects.forEach(subject => add('subject_daily_limit', { ...subjectFields([subject]), limit, parameters: { limit }, priority: 'hard' }));
    }
    if (!has('teacher_daily_limit')
        && /(?:每位|所有|全部)?老师.*(?:每天|一天).*(?:最多|顶多|不超过)/.test(value)) {
        const limit = constraintLimitFromText('teacher_daily_limit', value);
        add('teacher_daily_limit', { targetType: 'teacher', target: '全部教师', limit, parameters: { limit }, priority: 'soft' });
    }
    if (!has('teacher_consecutive_limit')
        && /老师.*(?:连续|连堂|连排).*(?:最多|不超过)/.test(value)) {
        const limit = teacherConsecutiveLimitFromText(value) || constraintLimitFromText('teacher_consecutive_limit', value);
        add('teacher_consecutive_limit', { targetType: 'teacher', target: '全部教师', limit, parameters: { limit }, priority: 'soft' });
    }
    if (!has('teacher_weekly_limit') && /(?:高负载|兼职|任课)?老师.*(?:每周|一周).*(?:最多|不要超过|不超过).*[一二两三四五六七八九十\d]+(?:节|课时)/.test(value)) {
        const limit = constraintLimitFromText('teacher_weekly_limit', value);
        add('teacher_weekly_limit', { targetType: teachers.length ? 'teacher' : 'derived_group', target: teachers[0]?.name || '教师组', limit, parameters: { limit }, priority: 'hard' });
    }

    if (!has('teacher_mutual_exclusion') && (teachers.length >= 2 || /跨校老师|跨校区老师/.test(value))
        && /(?:不能同一节|不能同时|错峰|尽量错开)/.test(value)) {
        add('teacher_mutual_exclusion', {
            targetType: 'teacher', target: teachers.map(item => item.name).join('、') || '跨校教师',
            teacherIds: teachers.map(item => item.id || item.name), teacherNames: teachers.map(item => item.name),
            priority: 'hard',
        });
    }
    if (!has('subject_spread') && marketSubjects.length
        && /(?:不要连着几天|别连着几天|分散|摊开|别扎堆)/.test(value)) {
        marketSubjects.forEach(subject => add('subject_spread', { ...subjectFields([subject]), priority: 'soft' }));
    }
    if (!has('class_daily_balance') && /(?:每个班|班级|主科).*(?:不要堆太多|别太集中|每天.*均衡)/.test(value)) {
        const item = { targetType: 'global', target: '全部班级', priority: 'soft' };
        if (/太集中/.test(value)) addClarification('class_daily_balance', item, '请明确主科每天允许的数量或期望均衡方式。');
        else add('class_daily_balance', item);
    }
    if (!has('teacher_gap_preference') && /(?:教师|老师).*(?:连贯|空档|一会儿有课一会儿没课)/.test(value)) {
        add('teacher_gap_preference', { targetType: 'global', target: '全部教师', priority: 'soft' });
    }
    if (!has('teacher_load_balance') && /(?:老师别太累|工作量.*均衡|整体负载.*公平)/.test(value)) {
        const item = { targetType: 'global', target: '全部教师', priority: 'soft' };
        if (/别太累/.test(value)) addClarification('teacher_load_balance', item, '请明确“别太累”对应日课量、连续课、空堂还是周负载指标。');
        else add('teacher_load_balance', item);
    }
    if (!result.some(item => (item.intent || item.type) === 'subject_not_same_day' && item.targetType === 'subject')
        && marketSubjects.length >= 2 && /(?:不要排在同一天|别放同一天|错峰|错开|别撞一天)/.test(value)) {
        add('subject_not_same_day', { ...subjectFields(marketSubjects), priority: 'hard' });
    }
    if (!has('subject_not_same_day') && /这几门课.*错开/.test(value)) {
        addClarification('subject_not_same_day', { targetType: 'subject', target: '这几门课', priority: 'soft' }, '请明确“这几门课”具体包含哪些课程，以及错开到不同天还是不同节。');
    }
    if (!result.some(item => (item.intent || item.type) === 'subject_sequence' && item.targetType === 'subject')
        && /(?:先.*再|先.*后|之后)/.test(value)) {
        const targets = marketSubjects.length >= 2 ? marketSubjects
            : /理论.*实验/.test(value) ? expandSubjects(['理论课', '实验课']) : [];
        if (targets.length >= 2) add('subject_sequence', {
            ...subjectFields(targets), beforeSubjectId: targets[0].id || targets[0].name,
            afterSubjectId: targets[1].id || targets[1].name, priority: 'soft',
        });
    }

    if (!has('block_preference') && /(?:作文课|课程|实验课).*(?:两节连上|连堂|连排两节)/.test(value)) {
        const targets = marketSubjects.length ? marketSubjects : expandSubjects([value.match(/[\u4e00-\u9fa5]{1,8}课/)?.[0] || '课程']);
        add('block_preference', { ...subjectFields(targets), limit: 2, blockPreference: 'double', parameters: { blockSize: 2 }, priority: 'soft' });
    }
    if (!has('week_pattern') && /(?:单双周|单周|双周)/.test(value)) {
        addClarification('week_pattern', { ...subjectFields(marketSubjects), weekPattern: /只在单周|单周上/.test(value) ? 'odd' : /只在双周|双周上/.test(value) ? 'even' : 'alternating', priority: 'hard' }, '请确认单双周课程对应的班级、教师和课时安排。');
    }
    if (!has('campus_commute_gap') && /(?:跨校区|校区).*(?:通勤|留出|至少隔一节)/.test(value)) {
        addClarification('campus_commute_gap', { targetType: 'teacher', target: teachers.map(item => item.name).join('、') || '跨校区教师', priority: 'hard' }, '请明确涉及的校区、教师及最小通勤间隔。');
    }
    if (!has('teaching_group_session') && /(?:合班|一起上|大课)/.test(value) && marketSubjects.length) {
        addClarification('teaching_group_session', { ...subjectFields(marketSubjects), targetType: 'teaching_group', priority: 'hard' }, '请明确参加合班课程的班级、教师和课程。');
    }
    if (!has('room_requirement') && !has('subject_avoid_periods')
        && /(?:实验室|机房|功能室).*(?:维修|维护|检修)/.test(value)
        && /实验课.*(?:避开|不排)/.test(value)) {
        const targets = marketSubjects.length ? marketSubjects : expandSubjects(['实验课']);
        addClarification('room_requirement', { ...subjectFields(targets), roomName: '实验室', parameters: { roomName: '实验室' }, priority: 'hard', activity: '实验室维修' }, '请明确维修影响的实验室和具体时段。');
        addClarification('subject_avoid_periods', { ...subjectFields(targets), days, priority: 'soft', activity: '实验室维修' }, '请明确实验课需要避开的具体节次。');
    }
    if (!has('teacher_avoid_periods') && /班主任.*(?:第一节|首节).*(?:不要有课|少排|别排)/.test(value)) {
        addClarification('teacher_avoid_periods', { targetType: 'derived_group', target: '班主任', periods: [1], slots: getActiveWeekdays(project).map(day => slotKey(day, 1)), priority: 'soft', activity: '晨检' }, '请确认班主任角色组包含的教师范围。');
    }

    const canonicalTargetKinds = new Map([
        ['teacher_daily_limit', 'teacher'],
        ['teacher_consecutive_limit', 'teacher'],
        ['teacher_mutual_exclusion', 'teacher'],
        ['subject_not_same_day', 'subject'],
        ['subject_sequence', 'subject'],
    ]);
    result.forEach(item => {
        const expectedKind = canonicalTargetKinds.get(item.intent || item.type);
        if (expectedKind) item.targetType = expectedKind;
        if ((item.intent || item.type) === 'subject_sequence' && marketSubjects.length >= 2) {
            item.target = marketSubjects.map(subject => subject.name).join('、');
            item.subjectIds = marketSubjects.map(subject => subject.id || subject.name);
            item.subjectNames = marketSubjects.map(subject => subject.name);
            item.beforeSubjectId = marketSubjects[0].id || marketSubjects[0].name;
            item.afterSubjectId = marketSubjects[1].id || marketSubjects[1].name;
        }
    });

    return result;
}

function localTextConstraints(project, text, sourceMeta = {}) {
    const constraints = [];
    const normalized = parserShadowTextWithTrace(text);
    const sentences = splitSentences(normalized.text);
    const rawSentences = splitSentences(text);
    const tracedSourceMeta = { ...sourceMeta, normalizationTrace: normalized.trace };
    const preferPattern = /(优先|尽量|prefer|preferred|安排到|可以(?:排|安排)?|适合)/i;
    const avoidPattern = /(避开|不要|不排|别(?:老)?(?:排|压|放|塞|搁)|avoid)/i;
    const context = {
        teacherTargets: [], classTargets: [], subjectTargets: [], roomTargets: [],
        teacherHistory: [], classHistory: [], subjectHistory: [],
        prefer: false, avoid: false, unavailable: false,
        days: [], periods: [], slots: [], dayPart: '', rawText: '', weekPattern: '', lastConstraintType: '',
    };

    for (const [sentenceGroupIndex, sentenceGroup] of sentences.entries()) {
        const rawSentenceGroup = rawSentences[sentenceGroupIndex] || sentenceGroup;
        const preciseConstraints = preciseSemanticConstraintsFromText(project, sentenceGroup, tracedSourceMeta);
        if (preciseConstraints.length) {
            constraints.push(...preciseConstraints);
            updateLocalContextFromPreciseConstraints(context, project, sentenceGroup, rawSentenceGroup, preciseConstraints);
            continue;
        }
        const parsedClauses = splitClauses(sentenceGroup);
        const rawClauses = splitClauses(rawSentenceGroup);

        for (const [clauseIndex, sentence] of parsedClauses.entries()) {
            const sourceSentence = rawClauses[clauseIndex] || sentence;
            const timeSpec = parseTimeSpec(sentence, project);
            const teacherTargets = textTeacherTargets(sentence, project);
            const classTargets = textClassTargets(sentence, project);
            const explicitSubjectTargets = textSubjectTargets(sentence, project, { allowHeuristic: false });
            const reference = contextReferenceResolution(sentence, context);
            const hasExplicitTarget = Boolean(teacherTargets.length || classTargets.length || explicitSubjectTargets.length);
            const continuation = isContinuationClause(sentence, context, { hasExplicitTarget });
            const refersToPreviousTime = reference.kind === 'time'
                || /^(?:这|该|此|上述)(?:一?节|个?(?:时间|时段))/.test(sentence)
                || /(?:这个要求|也一样|也同样|照这个要求|同一(?:时间|时段))/.test(sentence);
            const inheritsPredicateTime = continuation
                && context.slots.length > 0
                && (
                    hasUnavailableExpression(sentence)
                    || (context.avoid && /(?:不要|别|避开)/.test(sentence))
                    || (context.prefer && /(?:优先|尽量|最好|可以)/.test(sentence))
                )
                && !hasExplicitDayExpression(sentence)
                && !hasExplicitPeriodExpression(sentence)
                && !dayPartName(sentence);
            const inheritsPreviousTime = refersToPreviousTime || inheritsPredicateTime;
            const inheritWholeTime = inheritsPreviousTime
                && !hasExplicitDayExpression(sentence)
                && !hasExplicitPeriodExpression(sentence)
                && !dayPartName(sentence);
            const currentDays = inheritWholeTime ? [] : timeSpec.days;
            const currentPeriods = inheritWholeTime ? [] : timeSpec.periods;
            const inheritedDays = !currentDays.length
                && currentPeriods.length
                && (continuation || reference.kind)
                ? asList(context.days)
                : [];
            const effectiveDays = currentDays.length ? currentDays : inheritedDays;
            const parsedSlots = currentPeriods.length
                ? (effectiveDays.length ? effectiveDays : getActiveWeekdays(project))
                    .flatMap(day => currentPeriods.map(period => slotKey(day, period)))
                : [];
            const slots = parsedSlots.length ? parsedSlots : inheritsPreviousTime ? context.slots : [];
            const roomTargets = textRoomTargets(sentence, project);
            const matchedRoomTargets = roomTargets.filter(room => room.id);
            const explicitRoomTargets = matchedRoomTargets.length ? matchedRoomTargets : roomTargets;
            const effectiveRoomTargets = explicitRoomTargets.length
                ? explicitRoomTargets
                : continuation && context.lastConstraintType === 'room_requirement'
                    ? context.roomTargets
                    : [];
            let subjectTargets = explicitSubjectTargets.length
                ? explicitSubjectTargets
                : reference.kind === 'subject' && !reference.ambiguous
                    ? reference.targets
                    : continuation && !hasExplicitTarget
                        ? context.subjectTargets
                        : textSubjectTargets(sentence, project, {
                            allowHeuristic: teacherTargets.length === 0
                                && classTargets.length === 0
                                && !/(?:全校|全部|所有|统一|全体)/.test(sentence),
                        });
            if (hasMainSubjectShorthand(sentence)) subjectTargets = mainSubjectTargets(project);
            const effectiveTeacherTargets = teacherTargets.length
                ? teacherTargets
                : reference.kind === 'teacher' && !reference.ambiguous
                    ? reference.targets
                    : continuation && reference.kind !== 'class' && reference.kind !== 'subject'
                        ? context.teacherTargets : [];
            const effectiveClassTargets = classTargets.length
                ? classTargets
                : reference.kind === 'class' && !reference.ambiguous
                    ? reference.targets
                    : continuation && reference.kind !== 'teacher' && reference.kind !== 'subject'
                        ? context.classTargets : [];
            const effectiveSubjectTargets = subjectTargets.length
                ? subjectTargets
                : continuation && reference.kind !== 'teacher' && reference.kind !== 'class'
                    ? context.subjectTargets : [];

            if (reference.ambiguous && reference.kind && reference.kind !== 'time') {
                const ambiguousType = reference.kind === 'teacher' ? 'teacher_unavailable'
                    : reference.kind === 'class' ? 'class_unavailable' : 'subject_avoid_periods';
                constraints.push(clarificationSemanticConstraint({
                    type: ambiguousType,
                    capabilityId: reference.kind === 'teacher' ? 'teacher.unavailable'
                        : reference.kind === 'class' ? 'class.unavailable' : 'subject.avoid_periods',
                    targetType: reference.kind,
                    days: timeSpec.days, periods: timeSpec.periods, slots: parsedSlots,
                    priority: 'hard', reason: sourceSentence,
                    clarifications: [`“${sentence.match(/^(?:他|她|其|该老师|这位老师|前一位|后一位|这个班|该班|此班|前者|后者|这门课|该课程|此课程|它们|这个要求)/)?.[0] || '该指代'}”存在多个或缺失先行词，请明确对象。`],
                }, tracedSourceMeta));
                continue;
            }
            const hasPrefer = preferPattern.test(sentence) || (continuation && context.prefer);
            const hasAvoid = avoidPattern.test(sentence) || (continuation && context.avoid);
            const hasFixedClassActivity = effectiveClassTargets.length > 0
                && /(?:班会|校会|年级会|固定活动|集体活动)/.test(sentence)
                && slots.length > 0;
            const hasGlobalBlockingActivity = !effectiveTeacherTargets.length
                && !effectiveClassTargets.length
                && /(?:全校|全部|所有|统一|全体).{0,16}(?:开会|会议|集会|升旗|活动)/.test(sentence)
                && slots.length > 0;
            const hasUnavailable = hasUnavailableExpression(sentence)
                || hasFixedClassActivity
                || hasGlobalBlockingActivity
                || (continuation && context.unavailable);
            const unavailableDays = effectiveDays.length
                ? effectiveDays
                : inheritsPreviousTime ? asList(context.days) : [];
            const unavailablePeriods = currentPeriods.length
                ? currentPeriods
                : inheritsPreviousTime ? asList(context.periods) : [];
            const unavailableSlots = slots.length
                ? slots
                : hasUnavailable && unavailableDays.length
                    ? unavailableDays.flatMap(day => getActivePeriods(project).map(period => slotKey(day, period)))
                    : [];
            const rawText = continuation && context.rawText ? `${context.rawText}，${sourceSentence}` : sourceSentence;
            const weekPattern = timeSpec.weekPattern || weekPatternFromText(sentence) || (continuation ? context.weekPattern : '');
            if (/该课程.*实验室维修时段/.test(sentence) && effectiveSubjectTargets.length) {
                const subject = effectiveSubjectTargets[0];
                constraints.push(clarificationSemanticConstraint({
                    type: 'subject_avoid_periods', capabilityId: 'subject.avoid_periods',
                    targetType: 'subject', targetId: subject.id || '', target: subject.name,
                    subjectId: subject.id || '', subjectName: subject.name,
                    priority: 'hard', reason: rawText,
                    clarifications: ['请补充实验室维修对应的具体日期和节次。'],
                }, tracedSourceMeta));
                continue;
            }
            const effectiveDayPart = dayPartName(sentence)
                || (continuation && context.dayPart && !hasExplicitPeriodExpression(sentence) ? context.dayPart : '');
            const broadDayPartOnly = Boolean(effectiveDayPart) && !hasExplicitPeriodExpression(sentence);
            const hasDayPartConcentration = effectiveSubjectTargets.length > 0
                && /(?:不要|避免|不宜|尽量不).{0,16}(?:集中|扎堆|挤在).{0,12}(?:下午|午后)|(?:下午|午后).{0,12}(?:不要|避免|不集中)/.test(sentence);

            const boundaryPeriods = crossVenueBoundaryPeriods(project, sentence);
            if (boundaryPeriods.length) {
                constraints.push(withSource({
                    type: 'cross_venue_boundary',
                    capabilityId: 'schedule.cross_venue_boundary',
                    targetType: 'global',
                    target: '全校',
                    boundaryPeriods: boundaryPeriods.slice(0, 2),
                    priority: 'hard',
                    status: 'unsupported',
                    reason: rawText,
                    confidence: 0.92,
                    weekPattern,
                }, tracedSourceMeta));
                continue;
            }

            const concentrationSubjects = effectiveSubjectTargets.length
                ? effectiveSubjectTargets
                : context.subjectTargets;
            const concentrationDays = parseDays(sentence, project, []);
            if (
                concentrationSubjects.length
                && concentrationDays.length
                && /(?:不要|别)(?:都)?(?:挤|集中|堆)(?:在|到)|不要集中到/.test(sentence)
            ) {
                const concentrationRawText = context.rawText ? `${context.rawText}，${sentence}` : rawText;
                constraints.push(withSource({
                    type: 'avoid_weekday_concentration',
                    capabilityId: 'subject.avoid_weekday_concentration',
                    targetType: concentrationSubjects.length > 1 ? 'subject_group' : 'subject',
                    targetId: concentrationSubjects.length === 1 ? concentrationSubjects[0].id : '',
                    target: concentrationSubjects.map(subject => subject.name).join('、'),
                    subjectIds: concentrationSubjects.map(subject => subject.id || subject.name),
                    days: concentrationDays,
                    priority: 'soft',
                    status: 'unsupported',
                    reason: concentrationRawText,
                    confidence: 0.9,
                    weekPattern,
                }, tracedSourceMeta));
                continue;
            }

            if (unavailableSlots.length && hasUnavailable && /(全校|全部|所有|统一|学生课|升旗|早读|午休|大课间|广播操|全体)/.test(sentence) && !effectiveTeacherTargets.length && !effectiveClassTargets.length) {
                constraints.push(withSource({
                    type: 'global_unavailable',
                    target: '全校',
                    days: unavailableDays,
                    periods: unavailablePeriods,
                    slots: unavailableSlots,
                    priority: 'hard',
                    reason: rawText,
                    confidence: 0.86,
                    weekPattern,
                }, tracedSourceMeta));
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
                }, tracedSourceMeta));
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
                }, tracedSourceMeta));
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
                }, tracedSourceMeta));
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
                }, tracedSourceMeta));
            }

            if (/教师.*(均衡|平衡|公平)|负载.*(均衡|平衡|公平)/.test(sentence)) {
                constraints.push(withSource({
                    type: 'teacher_load_balance',
                    target: '全部教师',
                    priority: 'soft',
                    reason: rawText,
                    confidence: 0.86,
                    weekPattern,
                }, tracedSourceMeta));
            }

            if (/少空堂|别有空堂|不要.*空堂|空堂.*少|课.*连着上|排得?紧凑|课表.*紧凑|长空堂/.test(sentence)) {
                const gapTargets = effectiveTeacherTargets.length
                    ? effectiveTeacherTargets
                    : [{ id: '__all_teachers', name: '全部教师', group: true }];
                gapTargets.forEach(teacher => constraints.push(withSource({
                    type: 'teacher_gap_preference',
                    targetType: teacher.group ? 'teacher_group' : 'teacher',
                    targetId: teacher.id,
                    target: teacher.name,
                    priority: 'soft',
                    reason: rawText,
                    confidence: teacher.group ? 0.86 : teacher.id ? 0.88 : 0.74,
                    weekPattern,
                }, tracedSourceMeta)));
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
                }, tracedSourceMeta));
                continue;
            }

            effectiveTeacherTargets.forEach(teacher => {
                if (hasUnavailable && unavailableSlots.length) {
                    constraints.push(withSource({
                    type: 'teacher_unavailable',
                    targetId: teacher.id,
                    target: teacher.name,
                    days: unavailableDays,
                    periods: unavailablePeriods,
                    slots: unavailableSlots,
                    priority: 'hard',
                    reason: rawText,
                    confidence: teacher.id ? 0.88 : 0.74,
                    weekPattern,
                    }, tracedSourceMeta));
                }
                const explicitDailyLimit = constraintLimitFromText('teacher_daily_limit', sentence);
                const inheritedDailyMatch = (
                    context.lastConstraintType === 'teacher_daily_limit'
                        ? sentence.match(
                            new RegExp(`(?:(?:这个|该|此)?上限.{0,16}?(?:改成|改为|调成|调整为|为|是)?|(?:最多|不超过|不多于)\\s*)(${NUMBER_TOKEN_PATTERN})\\s*节`)
                        )
                        : null
                );
                const dailyLimit = Number.isInteger(explicitDailyLimit)
                    ? explicitDailyLimit
                    : parseLooseNumber(inheritedDailyMatch?.[1]);
                if (Number.isInteger(dailyLimit)) {
                    constraints.push(withSource({
                    type: 'teacher_daily_limit',
                    targetId: teacher.id,
                    target: teacher.name,
                    limit: dailyLimit,
                    priority: 'soft',
                    reason: rawText,
                    confidence: teacher.id ? 0.82 : 0.7,
                    weekPattern,
                    }, tracedSourceMeta));
                }
                const consecutiveLimit = teacherConsecutiveLimitFromText(sentence);
                if (Number.isInteger(consecutiveLimit)) {
                    constraints.push(withSource({
                    type: 'teacher_consecutive_limit',
                    targetId: teacher.id,
                    target: teacher.name,
                    limit: consecutiveLimit,
                    priority: 'soft',
                    reason: rawText,
                    confidence: teacher.id ? 0.8 : 0.68,
                    weekPattern,
                    }, tracedSourceMeta));
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
                    }, tracedSourceMeta));
                }
                const maxDaysPerWeek = constraintLimitFromText('teacher_max_days_per_week', sentence);
                if (Number.isInteger(maxDaysPerWeek)) {
                    constraints.push(withSource({
                    type: 'teacher_max_days_per_week',
                    targetId: teacher.id,
                    target: teacher.name,
                    limit: maxDaysPerWeek,
                    priority: 'hard',
                    reason: rawText,
                    confidence: teacher.id ? 0.88 : 0.7,
                    weekPattern,
                    }, tracedSourceMeta));
                }
            });
            effectiveClassTargets.forEach(klass => {
                if (hasUnavailable && unavailableSlots.length) {
                    constraints.push(withSource({
                    type: 'class_unavailable',
                    targetId: klass.id,
                    target: klass.name,
                    days: unavailableDays,
                    periods: unavailablePeriods,
                    slots: unavailableSlots,
                    priority: 'hard',
                    reason: rawText,
                    confidence: klass.id ? 0.84 : 0.68,
                    weekPattern,
                    }, tracedSourceMeta));
                }
            });
            effectiveSubjectTargets.forEach(subject => {
                const teacherUnavailableSentence = effectiveTeacherTargets.length > 0
                    && hasUnavailable
                    && !hasPrefer
                    && !effectiveClassTargets.length;
                if (teacherUnavailableSentence) return;
                if (slots.length && hasPrefer && !broadDayPartOnly) {
                    constraints.push(withSource({
                    type: 'subject_preferred_periods',
                    targetId: subject.id,
                    target: subject.name,
                    periods: currentPeriods.length ? currentPeriods : inheritsPreviousTime ? asList(context.periods) : [],
                    slots,
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.9 : 0.64,
                    weekPattern,
                    }, tracedSourceMeta));
                } else if (slots.length && hasAvoid && !hasDayPartConcentration) {
                    constraints.push(withSource({
                    type: 'subject_avoid_periods',
                    intent: /(?:最后一节|末节|收尾)/.test(sentence)
                        ? 'avoid_last_period'
                        : /(?:第一节|首节)/.test(sentence) ? 'avoid_first_period' : undefined,
                    targetId: subject.id,
                    target: subject.name,
                    days: effectiveDays,
                    periods: currentPeriods.length ? currentPeriods : inheritsPreviousTime ? asList(context.periods) : [],
                    slots,
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.9 : 0.64,
                    weekPattern,
                    }, tracedSourceMeta));
                } else if (effectiveDayPart === 'morning' && hasPrefer) {
                    constraints.push(withSource({
                    type: 'subject_morning',
                    targetId: subject.id,
                    target: subject.name,
                    dayPart: 'morning',
                    periods: getDayPartPeriods(project, 'morning'),
                    slots: getActiveWeekdays(project).flatMap(day => getDayPartPeriods(project, 'morning').map(period => slotKey(day, period))),
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.86 : 0.68,
                    weekPattern,
                    }, tracedSourceMeta));
                } else if (effectiveDayPart === 'afternoon' && hasPrefer) {
                    constraints.push(withSource({
                    type: 'subject_afternoon',
                    targetId: subject.id,
                    target: subject.name,
                    dayPart: 'afternoon',
                    periods: getDayPartPeriods(project, 'afternoon'),
                    slots: getActiveWeekdays(project).flatMap(day => getDayPartPeriods(project, 'afternoon').map(period => slotKey(day, period))),
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.86 : 0.68,
                    weekPattern,
                    }, tracedSourceMeta));
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
                    }, tracedSourceMeta));
                }
                const intervalMatch = sentence.match(new RegExp(`(?:间隔|隔开|岔开|至少间隔|至少隔|至少岔开).*?(${NUMBER_TOKEN_PATTERN})\\s*天|(${NUMBER_TOKEN_PATTERN})\\s*天.*?(?:间隔|隔开|岔开)`));
                const intervalDays = /(?:隔天|隔日|间隔一天|至少隔一天|至少岔开一天|不要连续两天)/.test(sentence)
                    ? 1
                    : intervalMatch
                        ? parseLooseNumber(intervalMatch[1] || intervalMatch[2])
                        : null;
                if (Number.isInteger(intervalDays) && intervalDays > 0) {
                    constraints.push(withSource({
                    type: 'course_interval',
                    capabilityId: 'subject.minimum_day_gap',
                    targetId: subject.id,
                    target: subject.name,
                    minGapDays: intervalDays,
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.86 : 0.64,
                    weekPattern,
                    }, tracedSourceMeta));
                }
                if (/(?:尽量|最好|需要|要).*(?:分散|摊开)|(?:一周|每周)?.*(?:分散(?:点|些|一点)?|摊开)|(?:不要|别|避免).*(?:扎堆|挤在一起)/.test(sentence)) {
                    constraints.push(withSource({
                    type: 'subject_spread',
                    capabilityId: 'subject.spread',
                    targetId: subject.id,
                    target: subject.name,
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.86 : 0.64,
                    weekPattern,
                    }, tracedSourceMeta));
                }
                const hasSpecializedRoomConstraint = constraints.some(item => (
                    ['room.required', 'room.preferred', 'room.forbidden_type'].includes(item.capabilityId)
                    && (item.targetId || item.subjectId || '') === (subject.id || '')
                ));
                if (
                    !hasSpecializedRoomConstraint
                    && effectiveRoomTargets.length
                    && /(教室|场地|实验室|机房|操场|体育馆|音乐室|美术室|功能室|安排|使用|去|在)/.test(sentence)
                ) {
                    const roomName = effectiveRoomTargets[0]?.name || '';
                    const roomConstraint = {
                        type: 'room_requirement',
                        capabilityId: 'room.required',
                        targetType: 'subject',
                        targetId: subject.id,
                        target: subject.name,
                        roomIds: effectiveRoomTargets.map(room => room.id || room.name),
                        roomName,
                        requiredTags: roomTagsFromText(roomName, sentence),
                        priority: 'hard',
                        reason: rawText,
                        confidence: subject.id ? 0.88 : 0.64,
                        weekPattern,
                    };
                    const needsRoomClarification = effectiveRoomTargets.every(room => (
                        !room.id && roomMentionNeedsClarification(room.name)
                    ));
                    constraints.push(needsRoomClarification
                        ? clarificationSemanticConstraint({
                            ...roomConstraint,
                            roomIds: [],
                            requiredTags: [],
                            clarifications: ['请明确具体教室，或补充可验证的教室资源类型。'],
                        }, tracedSourceMeta)
                        : withSource(roomConstraint, tracedSourceMeta));
                }
            });

            if (teacherTargets.length) {
                context.teacherTargets = teacherTargets;
                appendContextHistory(context, 'teacher', teacherTargets);
            }
            if (classTargets.length) {
                context.classTargets = classTargets;
                appendContextHistory(context, 'class', classTargets);
            }
            if (explicitSubjectTargets.length) {
                context.subjectTargets = explicitSubjectTargets;
                appendContextHistory(context, 'subject', explicitSubjectTargets);
            } else if (subjectTargets.length && reference.kind !== 'subject') {
                context.subjectTargets = subjectTargets;
                appendContextHistory(context, 'subject', subjectTargets);
            }
            if (explicitRoomTargets.length) context.roomTargets = explicitRoomTargets;
            if (hasPrefer) context.prefer = true;
            if (hasAvoid) context.avoid = true;
            if (hasUnavailable || (classTargets.length && /(?:班会|活动)/.test(sentence))) context.unavailable = true;
            if (currentDays.length) context.days = currentDays;
            if (currentPeriods.length) context.periods = currentPeriods;
            if (slots.length) context.slots = slots;
            if (dayPartName(sentence)) context.dayPart = dayPartName(sentence);
            if (weekPattern) context.weekPattern = weekPattern;
            const latestConstraint = constraints.at(-1);
            if (latestConstraint?.type) context.lastConstraintType = latestConstraint.type;
            if (teacherTargets.length || classTargets.length || subjectTargets.length || slots.length || hasPrefer || hasAvoid || hasUnavailable) {
                context.rawText = rawText;
            }
        }
    }

    // Prepared parse inputs already represent one stable SourceRequirement. Running the
    // legacy whole-prompt fallback again invents extra targets from clause fragments.
    const needsRegisteredAliasExpansion = /(?:物化生|物理、化学、生物|音体美信|音乐、体育、美术、信息技术)/.test(normalized.text);
    const augmentedConstraints = tracedSourceMeta.sourceId && !needsRegisteredAliasExpansion
        ? constraints
        : categorizedMarketFallbackConstraints(project, normalized.text, tracedSourceMeta, constraints);
    return compactLocalConstraints(augmentedConstraints);
}

function structuredConstraintFromRow(project, row = {}) {
    const type = normalizeConstraintType(row.ruleType || row.type || '');
    const rawTarget = asText(row.target || row.targetName || row.teacherName || row.className || row.subjectName || '', 200);
    const target = targetTypeFor(type, row) === 'teacher'
        ? rawTarget.replace(/(?:老师|教师)$/u, '')
        : rawTarget;
    const rawText = asText(row.constraintText || row.description || row.ruleName || '', 1500)
        || [
            row.ruleName ? `名称：${row.ruleName}` : '',
            row.ruleType ? `类型：${row.ruleType}` : '',
            target ? `对象：${target}` : '',
            row.days ? `周几：${row.days}` : '',
            row.periods ? `节次：${row.periods}` : '',
            row.slots ? `时间：${row.slots}` : '',
        ].filter(Boolean).join('；');
    const sourceMeta = {
        sourceId: row.sourceId,
        textHash: row.textHash,
        origin: row.origin || 'unknown',
        parsedBy: normalizedParsedBy(row.parsedBy, 'local'),
        parser: 'local',
        sourceSheet: row.sourceSheet,
        sourceRow: row.sourceRow,
        lineNumber: row.lineNumber,
        rawText,
    };
    const preciseConstraints = preciseSemanticConstraintsFromText(project, rawText, sourceMeta, row);
    if (preciseConstraints.length) return preciseConstraints;
    if (!SUPPORTED_EFFECTIVE_TYPES.has(type) && !SUGGESTION_ONLY_TYPES.has(type)) return null;

    const targetType = targetTypeFor(type, row);
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
        limit: row.limit ?? row.value ?? row.max ?? constraintLimitFromText(type, rawText),
        minGapDays: row.minGapDays || row.gapDays,
        teacherIds: normalizedTextValues(120, row.teacherIds),
        subjectIds: normalizedTextValues(120, row.subjectIds),
        classIds: normalizedTextValues(120, row.classIds),
        roomIds: normalizedTextValues(120, row.roomIds, row.allowedRoomIds),
        roomName: row.roomName || row.room || '',
        requiredTags: normalizedTextValues(120, row.requiredTags, row.roomTags),
        beforeSubjectId: row.beforeSubjectId || row.before || '',
        afterSubjectId: row.afterSubjectId || row.after || '',
        reason: row.description || rawText,
        confidence: 0.95,
        sourceId: row.sourceId,
        textHash: row.textHash,
        origin: row.origin || 'unknown',
        parsedBy: normalizedParsedBy(row.parsedBy, 'local'),
        sourceSheet: row.sourceSheet,
        sourceRow: row.sourceRow,
        lineNumber: row.lineNumber,
    };

    if (type === 'room_requirement') {
        const extractedRooms = textRoomTargets(rawText, project);
        const extractedRoomIds = extractedRooms.map(room => room.id || room.name).filter(Boolean);
        const extractedRoomNames = extractedRooms.map(room => room.name || room.id).filter(Boolean);
        base.roomIds = [...new Set([...(base.roomIds || []), ...extractedRoomIds])];
        base.roomName = base.roomName || extractedRoomNames[0] || '';
        base.requiredTags = [...new Set([
            ...(base.requiredTags || []),
            ...roomTagsFromText(extractedRoomNames.join('、'), rawText),
        ])];
    }
    if (type === 'block_protection') {
        const subjects = textSubjectTargets(rawText, project);
        const [subject] = subjects;
        if (subjects.length === 1) {
            base.targetType = 'subject';
            base.target = subject.name;
            base.targetName = subject.name;
            base.targetId = subject.id || '';
            base.subjectId = subject.id || '';
            base.subjectName = subject.name;
            base.subject = subject.name;
        }
        base.blockPreference = blockPreferenceFromText(rawText) || row.blockPreference || '';
        base.gradeNames = gradeNamesFromText(rawText);
    }
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
    const rowList = asList(constraintRows).filter(row => row && typeof row === 'object');
    if (rowList.length) {
        const constraints = rowList.flatMap(row => {
            const rowText = asText(row.constraintText || row.rawText || row.description || '', 1500);
            if (!rowText) return [];
            const sourceMeta = {
                sourceId: row.sourceId,
                textHash: row.textHash,
                origin: row.origin || 'unknown',
                parsedBy: normalizedParsedBy(row.parsedBy, 'local'),
                parser: 'local',
                sourceSheet: row.sourceSheet,
                sourceRow: row.sourceRow,
                lineNumber: row.lineNumber,
                rawText: rowText,
            };

            // 结构化 Excel 列可能只是人工摘要，不能覆盖原文中更具体的关系语义。
            // 例如“第4节和第5节之间不要安排跨场地连续课程”不是普通课程间隔。
            if (crossVenueBoundaryPeriods(project, rowText).length) {
                return localTextConstraints(project, rowText, sourceMeta);
            }
            if (options.preferStructuredRows) {
                const structured = structuredConstraintFromRow(project, row);
                if (structured) return Array.isArray(structured) ? structured : [structured];
            }
            return localTextConstraints(project, rowText, sourceMeta);
        });
        return compactLocalConstraints(constraints);
    }
    const sourceList = asList(options.sourceRequirements).filter(item => item && typeof item === 'object');
    if (sourceList.length) {
        return compactLocalConstraints(sourceList.flatMap((sourceRequirement) => {
            const source = sourceRequirement.source || {};
            const rawText = asText(source.rawText || sourceRequirement.rawText || '', 1500);
            if (!rawText) return [];
            return localTextConstraints(project, rawText, {
                sourceId: sourceRequirement.sourceId || source.sourceId,
                textHash: source.textHash || sourceRequirement.textHash || '',
                origin: sourceRequirement.origin || source.origin || 'unknown',
                parsedBy: normalizedParsedBy(sourceRequirement.parsedBy, source.parsedBy, 'local'),
                parser: 'local',
                sourceSheet: source.sheetName || sourceRequirement.sourceSheet || '',
                sourceRow: source.rowNumber ?? sourceRequirement.sourceRow ?? null,
                lineNumber: source.lineNumber ?? sourceRequirement.lineNumber ?? null,
                rawText,
            });
        }));
    }
    return localTextConstraints(project, text);
}

function sourceRowsForParse({ text = '', inputType = 'text', constraintRows = [], origin = 'user_input' } = {}) {
    const rows = asList(constraintRows).filter(row => row && typeof row === 'object');
    if (rows.length) {
        return rows.map((row, index) => ({
            ...row,
            rawText: row.rawText || row.constraintText || row.description || row.reason || '',
            sourceIndex: index,
            inputType,
            origin: row.origin || origin,
        }));
    }
    return sourceInputRowsFromText(text, { inputType, origin });
}

function prepareSourceInputs({ text = '', inputType = 'text', constraintRows = [], fileName = '', origin = 'user_input' } = {}) {
    const sourceRows = sourceRowsForParse({ text, inputType, constraintRows, origin })
        .filter(row => asText(row.rawText || row.constraintText || row.description || row.reason || '', 2000));
    const sourceRequirements = buildSourceRequirements(sourceRows, { inputType, fileName, origin });
    const enrichedRows = sourceRows.map((row, index) => {
        const sourceRequirement = sourceRequirements[index];
        return {
            ...row,
            rawText: sourceRequirement.source.rawText,
            constraintText: row.constraintText || sourceRequirement.source.rawText,
            sourceId: sourceRequirement.sourceId,
            textHash: sourceRequirement.source.textHash,
            origin: sourceRequirement.origin,
            parsedBy: normalizedParsedBy(row.parsedBy, origin === 'manual' ? 'manual' : []),
            sourceSheet: row.sourceSheet || sourceRequirement.source.sheetName || undefined,
            sourceRow: row.sourceRow || sourceRequirement.source.rowNumber || undefined,
            lineNumber: row.lineNumber || sourceRequirement.source.lineNumber || undefined,
        };
    });
    return { sourceRequirements, sourceRows: enrichedRows };
}

function parserActors(parseSource = '') {
    const value = String(parseSource || '').toLowerCase();
    const actors = [];
    if (value.includes('local') || value.includes('xlsx')) actors.push('local');
    if (value.includes('ai')) actors.push('ai');
    if (!actors.length && value) actors.push(value);
    return actors;
}

function asList(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    return [value];
}

function normalizedTextValues(maxLength = 240, ...values) {
    return [...new Set(values
        .flatMap(value => asList(value))
        .map(value => asText(value, maxLength))
        .filter(Boolean))];
}

function normalizedMessageValues(maxLength = 240, ...values) {
    return normalizedTextValues(
        maxLength,
        values.flatMap(value => asList(value)).map(item => (
            item && typeof item === 'object'
                ? item.message || item.reason || item.suggestion || item.description || item.question || ''
                : item
        ))
    );
}

function normalizedParsedBy(...values) {
    return [...new Set(values.flatMap(value => asList(value))
        .map(value => asText(value, 80))
        .filter(Boolean))];
}

export {
    TimetableRuleParseError,
    aiDraftRowsFromParsed,
    asList,
    asText,
    callAi,
    classifyWorkbook,
    cleanRulePromptText,
    compactParseResultForReview,
    compactProjectDictionary,
    constraintsTextFromSheet,
    entityItemsForType,
    entityLabel,
    entityNamesForMatch,
    findEntity,
    findTarget,
    isAllTeachersTarget,
    isSystemHandledDraftRow,
    localTextConstraintsFromInput,
    matchEntityCandidates,
    normalizeAiContent,
    normalizeAllTeachersTargetRow,
    normalizeConstraintType,
    normalizePriority,
    normalizeRosterFallback,
    normalizeSlotList,
    normalizedMessageValues,
    normalizedParsedBy,
    normalizedTextValues,
    parseDays,
    parseLooseNumber,
    parsePeriods,
    parserActors,
    parserShadowText,
    preciseSemanticConstraintsFromText,
    prepareSourceInputs,
    projectWithRosterPreview,
    resolveAiConfig,
    resolveFetch,
    rosterContext,
    rowsFromAiConstraints,
    sourceRowsForParse,
    shouldNormalizeAllTeachersTarget,
    slotsFromConstraint,
    splitClauses,
    splitSentences,
    targetTypeFor,
    textClassTargets,
    textFromConstraintRows,
    textSubjectTargets,
    textTeacherTargets,
    warningMessagesFromAi,
    weekPatternFromText,
    workbookSheets,
};
