import { createHash } from 'node:crypto';

import {
    makeTimetableId,
    normalizeSubjectCategory,
    normalizeSubjectTags,
} from './timetable-scheduler.js';
import {
    normalizeTimetableActivityTypes,
    normalizeTimetableResourceTypes,
} from '../../shared/timetable/lesson-metadata.js';
import { readRosterFileSource } from './timetable-roster-workbook.js';

const PALETTE = ['#14b8a6', '#60a5fa', '#f59e0b', '#f97316', '#a78bfa', '#22c55e', '#ef4444', '#06b6d4'];
const MAX_ROSTER_AI_CALLS = 8;
const MAX_ROSTER_AI_INPUT_CHARS = 10_000;
const MAX_ROSTER_AI_BATCH_ROWS = 45;
const MAX_HEADER_SCAN_ROWS = 30;
const REQUIRED_ROSTER_FIELDS = ['className', 'subjectName', 'teacherName'];
const AI_HEADER_FIELDS = new Set([
    'grade',
    'className',
    'subjectName',
    'teacherName',
    'weeklyHours',
    'blockPreference',
    'roomName',
    'subjectCategory',
    'subjectTags',
    'activityTypes',
    'requiredResourceTypes',
]);
const COMMON_ROSTER_SUBJECTS = [
    '道德与法治', '信息技术', '综合实践', '劳动技术', '心理健康',
    '道法', '信息',
    '语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '政治',
    '体育', '音乐', '美术', '科学', '劳动', '阅读', '书法', '班会',
];
const CHINESE_NUMBER_DIGITS = new Map([
    ['零', 0], ['〇', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3],
    ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9],
]);

function cleanCell(value) {
    return String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function splitLine(line) {
    return String(line ?? '')
        .replace(/[|；;]/g, ',')
        .split(/\t|,|，/)
        .map(cleanCell);
}

function splitEntityNames(value) {
    return cleanCell(value)
        .split(/[、,，/／;；|]+/)
        .map(cleanCell)
        .filter(Boolean);
}

function normalizeHeader(value) {
    const text = cleanCell(value).toLowerCase();
    if (/课程类型|课程类别|学科类型|subject\s*(category|type)|course\s*(category|type)|category|type/.test(text)) return 'subjectCategory';
    if (/课程标签|学科标签|subject\s*tags?|course\s*tags?|tags?/.test(text)) return 'subjectTags';
    if (/年级|grade/.test(text)) return 'grade';
    if (/班级|class/.test(text)) return 'className';
    if (/课程|科目|学科|subject|course/.test(text)) return 'subjectName';
    if (/教师|老师|teacher/.test(text)) return 'teacherName';
    if (/课时|周课时|hours|hour/.test(text)) return 'weeklyHours';
    if (/连堂|块|block/.test(text)) return 'blockPreference';
    if (/教室|场地|room|classroom/.test(text)) return 'roomName';
    if (/活动类型|课程类型|课型|activity/.test(text)) return 'activityTypes';
    if (/资源类型|教学资源|resource/.test(text)) return 'requiredResourceTypes';
    return null;
}

function parseBlockPreferenceInfo(value) {
    const raw = cleanCell(value);
    const text = raw.toLowerCase();
    if (!text) return { value: 'single', raw, degraded: false };
    if (['single', '1'].includes(text) || /单节|普通|常规/.test(text)) return { value: 'single', raw, degraded: false };
    if (/三|3|three|triple/.test(text)) return { value: 'single', raw, degraded: true };
    if (['double', 'block', '2'].includes(text) || /双|两|连堂|double|block/.test(text)) return { value: 'double', raw, degraded: false };
    if (['mixed', 'mix'].includes(text) || /混|单双|mixed|mix/.test(text)) return { value: 'mixed', raw, degraded: false };
    return { value: 'single', raw, degraded: true };
}

function roomTagsFromName(value = '') {
    // A room label is not a resource contract. Tags must arrive through an
    // explicit column or a confirmed rule, never through name guessing.
    return [];
}

function rosterRoomId(name = '') {
    const normalized = cleanCell(name).toLowerCase();
    return `room_${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

function mergeExplicitLessonMetadata(row = {}, roomTags = []) {
    const activityTypes = [...new Set(row.activityTypes || [])];
    const requiredResourceTypes = [...new Set(row.requiredResourceTypes || [])];
    const explicitCourseTags = [row.explicitSubjectCategory, ...(row.subjectTags || [])].join(' ');
    if (/实验|lab/i.test(explicitCourseTags) && !activityTypes.includes('实验课')) activityTypes.push('实验课');
    if (roomTags.some(tag => tag === '实验室') && !requiredResourceTypes.includes('实验室')) requiredResourceTypes.push('实验室');
    if (roomTags.some(tag => tag === '机房' || tag === '计算机教室') && !requiredResourceTypes.includes('计算机教室')) requiredResourceTypes.push('计算机教室');
    return { activityTypes, requiredResourceTypes };
}

function blockPreferenceReportReason(row = {}) {
    return `无法识别“${row.rawBlockPreference || '未填写'}”，已按单节处理。`;
}

function createRosterImportReport(sourceKind = 'roster') {
    const entries = [];
    const add = (category, { source = null, field = '', reason = '', originalValue } = {}) => {
        const entry = { category, source, field, reason };
        if (originalValue !== undefined) entry.originalValue = originalValue;
        entries.push(entry);
        return entry;
    };
    return {
        add,
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

export function buildRosterImportReport(preview = {}) {
    const report = createRosterImportReport('roster');
    const rows = Array.isArray(preview.draftRows) ? preview.draftRows : [];
    const issues = Array.isArray(preview.issues) ? preview.issues : [];
    const issuesByRow = new Map();
    issues.forEach(issue => {
        if (!issue.rowId) return;
        if (!issuesByRow.has(issue.rowId)) issuesByRow.set(issue.rowId, []);
        issuesByRow.get(issue.rowId).push(issue);
    });

    rows.forEach(row => {
        const rowSource = { sheet: row.sourceSheet || null, row: row.sourceRow || null, rowId: row.id || null };
        const rowIssues = issuesByRow.get(row.id) || row.issues || [];
        const errors = rowIssues.filter(issue => issue.severity === 'error');
        const warnings = rowIssues.filter(issue => issue.severity !== 'error');
        if (errors.length) {
            errors.forEach(issue => report.dropped({
                source: rowSource,
                field: issue.field || 'row',
                reason: issue.message || '该行无法导入。',
                originalValue: {
                    grade: row.grade,
                    className: row.className,
                    subjectName: row.subjectName,
                    teacherName: row.teacherName,
                    weeklyHours: row.weeklyHours,
                },
            }));
            return;
        }
        if (warnings.length) {
            warnings.forEach(issue => report.review({
                source: rowSource,
                field: issue.field || 'row',
                reason: issue.message || '该行需要人工复核。',
            }));
        } else {
            report.kept({
                source: rowSource,
                field: 'row',
                reason: '任课行已保留。',
            });
        }
        if (row.blockPreferenceDegraded && row.rawBlockPreference) {
            report.degraded({
                source: rowSource,
                field: 'blockPreference',
                reason: blockPreferenceReportReason(row),
                originalValue: row.rawBlockPreference,
            });
        }
    });

    issues
        .filter(issue => !issue.rowId)
        .forEach(issue => {
            const category = issue.severity === 'error' ? 'dropped' : 'review';
            report[category]({
                source: { sheet: issue.sourceSheet || null, row: issue.sourceRow || null, rowId: null },
                field: issue.field || 'row',
                reason: issue.message || '导入数据需要复核。',
            });
        });

    return report.toJSON();
}

function blockLabel(value) {
    if (value === 'double') return '双连堂';
    if (value === 'mixed') return '混合';
    return '单节';
}

function parseWeeklyHours(value) {
    const text = cleanCell(value);
    if (!text) return 0;
    const plus = text.match(/^(\d+)\s*\+\s*(\d+)$/);
    if (plus) return Number(plus[1]) + Number(plus[2]) * 2;
    const match = text.match(/\d+/);
    if (match) return Number(match[0]);
    const chinese = text.match(/[零〇一二两三四五六七八九十]+/);
    return chinese ? parseChineseInteger(chinese[0]) : 0;
}

function pushUnique(map, key, value) {
    if (!map.has(key)) map.set(key, value);
    return map.get(key);
}

function parseChineseInteger(value) {
    const text = cleanCell(value);
    const digit = text.match(/\d+/);
    if (digit) return Number(digit[0]);
    if (!text) return 0;
    if (text.includes('十')) {
        const [tensText, onesText] = text.split('十');
        const tens = tensText ? CHINESE_NUMBER_DIGITS.get(tensText) ?? 0 : 1;
        const ones = onesText ? CHINESE_NUMBER_DIGITS.get(onesText) ?? 0 : 0;
        return tens * 10 + ones;
    }
    return CHINESE_NUMBER_DIGITS.get(text) ?? 0;
}

function rosterSubjectCandidates(project = {}) {
    const known = (project.subjects || []).map(subject => subject.name).filter(Boolean);
    return [...new Set([...known, ...COMMON_ROSTER_SUBJECTS].map(cleanCell).filter(Boolean))]
        .sort((left, right) => right.length - left.length);
}

function splitRosterInputLines(text = '') {
    return String(text)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
}

function hasRosterHeaderLine(line = '') {
    const header = splitLine(line).map(normalizeHeader);
    return header.includes('className') && header.includes('subjectName') && header.includes('teacherName');
}

function isTableLikeRosterLine(line = '') {
    if (/[。！？]|(?:任教|授课|每周|一周|上课地点|课程类型|课程标签)/.test(line)) return false;
    const parts = splitLine(line).filter(Boolean);
    return parts.length >= 5 && parseWeeklyHours(parts[4]) > 0;
}

function shouldParseRosterAsTable(lines = []) {
    if (!lines.length) return false;
    if (hasRosterHeaderLine(lines[0])) return true;
    return lines.every(isTableLikeRosterLine);
}

function extractNaturalClass(text = '') {
    const source = cleanCell(text);
    const gradePattern = '([零〇一二两三四五六七八九十\\d]+年级|[初高][一二三123])';
    const codedClass = '(G\\d+\\s*[-_－—]\\s*[零〇一二两三四五六七八九十\\d]+\\s*班)';
    const ordinaryClass = '([零〇一二两三四五六七八九十\\d]+\\s*班)';
    const match = source.match(new RegExp(`(?:${gradePattern}\\s*)?${codedClass}`, 'i'))
        || source.match(new RegExp(`${gradePattern}\\s*${ordinaryClass}`, 'i'));
    if (!match) return null;
    const grade = cleanCell(match[1] || match[0].match(/^G\\d+/i)?.[0]);
    const className = cleanCell(match[2] || match[3])
        .replace(/\\s*[-_－—]\\s*/g, '-')
        .replace(/\\s+班$/g, '班');
    return {
        grade,
        className,
        rest: source.slice(match.index + match[0].length),
    };
}

function extractNaturalWeeklyHours(text = '') {
    const match = cleanCell(text).match(/(?:每周|一周|周课时|周课|每星期|一星期)\s*(?:安排|设置|开设|为|共|需要)?\s*([零〇一二两三四五六七八九十\d]+)\s*(?:节|课时)?/);
    return match ? parseChineseInteger(match[1]) : 0;
}

function extractNaturalBlockPreference(text = '') {
    const value = cleanCell(text);
    if (/不(?:要求|需|需要)?连堂|不要连堂|不连堂|按单节|单节课安排/.test(value)) return 'single';
    if (/混合|单双|单节(?:和|或|与)连堂|连堂或单节/.test(value)) return 'mixed';
    if (/双连堂|连续\s*(?:2|两|二)\s*节|连堂/.test(value)) return 'double';
    if (/单节/.test(value)) return 'single';
    return 'single';
}

function normalizeNaturalRoomNames(value = '') {
    return cleanCell(value)
        .replace(/^(?:为|是|：|:)/, '')
        .split(/\s*(?:或者|或|、|\/|／)\s*/)
        .map(cleanCell)
        .filter(Boolean)
        .join('、');
}

function extractNaturalRoom(text = '') {
    const value = cleanCell(text);
    const labelled = value.match(/(?:上课地点|授课地点|上课教室|地点|场地)\s*(?:为|是|：|:)\s*([^，,。；;]+)/);
    if (labelled) return normalizeNaturalRoomNames(labelled[1]);
    const roomPattern = /(实验室|教室|机房|电脑房|体育馆|操场|音乐室|美术室|舞蹈室|功能室|专用教室|场馆|礼堂)$/;
    const segments = value
        .split(/[，,。；;]/)
        .map(segment => cleanCell(segment).replace(/^(?:安排)?(?:在|到|使用)/, ''))
        .filter(Boolean);
    const segment = segments.find(item => roomPattern.test(item) && !/(老师|每周|一周|周课时|周课|节)/.test(item));
    if (segment) return normalizeNaturalRoomNames(segment);
    const match = value.match(/(?:安排)?(?:在|到|使用)\s*([^，,。；;]+?(?:实验室|教室|机房|电脑房|体育馆|操场|音乐室|美术室|舞蹈室|功能室|专用教室|场馆|礼堂))/);
    return match ? normalizeNaturalRoomNames(match[1]) : '';
}

function extractNaturalSubjectCategory(text = '') {
    const match = cleanCell(text).match(/(?:课程|学科)(?:类型|类别)\s*(?:为|是|：|:)\s*([^，,。；;]+)/);
    const value = cleanCell(match?.[1]);
    if (!value) return '';
    if (/主科|核心/.test(value)) return 'main';
    if (/实验/.test(value)) return 'lab';
    if (/活动|场地|素质|艺体/.test(value)) return 'quality';
    if (/普通|常规/.test(value)) return 'normal';
    return value;
}

function extractNaturalSubjectTags(text = '') {
    const match = cleanCell(text).match(/(?:课程|学科)标签\s*(?:为|是|：|:)\s*([^。；;]+)/);
    return cleanCell(match?.[1]);
}

function findNaturalSubject(text = '', project = {}) {
    const source = cleanCell(text);
    const matches = rosterSubjectCandidates(project)
        .map(name => ({ name, index: source.indexOf(name) }))
        .filter(item => item.index >= 0)
        .sort((left, right) => left.index - right.index || right.name.length - left.name.length);
    return matches[0] || null;
}

function normalizeNaturalTeacherName(value = '') {
    let text = cleanCell(value)
        .replace(/^(?:由|教师|老师|任课教师|任课老师|上课教师|上课老师|为|是)/, '')
        .replace(/(?:负责|任教|授课|上课|上)$/g, '')
        .replace(/[的：:]+$/g, '');
    if (/^[\u4e00-\u9fa5]老师$/.test(text)) return text;
    if (/^[\u4e00-\u9fa5]{2,5}老师$/.test(text)) return text.replace(/老师$/, '');
    return text;
}

function extractNaturalTeacher(afterSubject = '') {
    const teacherText = cleanCell(afterSubject)
        .split(/(?:每周|一周|周课时|周课|每星期|一星期|双连堂|单节|混合|连堂|在|到|，|,|。|；|;)/)[0];
    return normalizeNaturalTeacherName(teacherText);
}

function parseNaturalRosterLine(line = '', project = {}, index = 0) {
    const text = cleanCell(line);
    const classInfo = extractNaturalClass(text);
    if (!classInfo) return null;
    const subject = findNaturalSubject(classInfo.rest, project);
    if (!subject) return null;
    const afterSubject = classInfo.rest.slice(subject.index + subject.name.length);
    const teacherName = extractNaturalTeacher(afterSubject);
    const weeklyHours = extractNaturalWeeklyHours(text);
    if (!teacherName || !weeklyHours) return null;
    const roomName = extractNaturalRoom(text);
    const subjectCategory = extractNaturalSubjectCategory(text);
    const subjectTags = extractNaturalSubjectTags(text);
    const metadata = mergeExplicitLessonMetadata({
        explicitSubjectCategory: subjectCategory,
        subjectTags: normalizeSubjectTags(subjectTags),
    }, roomTagsFromName(roomName));
    return {
        sourceRow: index + 1,
        grade: classInfo.grade,
        className: classInfo.className,
        subjectName: subject.name,
        teacherName,
        weeklyHours,
        blockPreference: extractNaturalBlockPreference(text),
        roomName,
        subjectCategory,
        subjectTags,
        activityTypes: metadata.activityTypes,
        requiredResourceTypes: metadata.requiredResourceTypes,
    };
}

function parseNaturalRosterRows(lines = [], project = {}) {
    return lines
        .map((line, index) => parseNaturalRosterLine(line, project, index))
        .filter(Boolean);
}

function unrecognizedRosterTextResult(project = {}) {
    const result = analyzeDraftRows([], project);
    const issue = {
        rowId: '',
        sourceRow: null,
        severity: 'warning',
        field: 'row',
        message: '本地未能识别自然语言，请改用表格格式，或配置 AI 后重试。',
    };
    result.issues = [issue];
    result.warnings = [issue.message];
    result.stats = { ...result.stats, issueCount: 1 };
    result.importReport = buildRosterImportReport(result);
    return result;
}

function parseRows(lines) {
    const rows = lines.map(splitLine).filter(parts => parts.some(Boolean));
    if (!rows.length) return [];

    let header = rows[0].map(normalizeHeader);
    let start = 1;
    if (!header.includes('className') || !header.includes('subjectName') || !header.includes('teacherName')) {
        header = ['grade', 'className', 'subjectName', 'teacherName', 'weeklyHours', 'blockPreference', 'roomName'];
        start = 0;
    }

    return rows.slice(start).map((parts, index) => {
        const row = { sourceRow: index + start + 1 };
        header.forEach((key, columnIndex) => {
            if (key) row[key] = parts[columnIndex];
        });
        return row;
    });
}

function rowHasAnyValue(row = {}) {
    return [
        row.grade,
        row.className,
        row.subjectName,
        row.teacherName,
        row.weeklyHours,
        row.blockPreference,
        row.roomName,
        row.subjectCategory,
        row.subjectTags,
        row.activityTypes,
        row.requiredResourceTypes,
    ].some(value => cleanCell(value));
}

function normalizeDraftRow(row = {}, index = 0) {
    const teacherName = splitEntityNames(row.teacherName).join('、');
    const roomName = splitEntityNames(row.roomName || row.roomId || row.allowedRoomIds).join('、');
    const explicitSubjectCategory = cleanCell(row.subjectCategory || row.category || row.subjectType);
    const subjectCategory = normalizeSubjectCategory(explicitSubjectCategory);
    const subjectTags = normalizeSubjectTags(row.subjectTags || row.tags);
    const blockPreference = parseBlockPreferenceInfo(row.blockPreference);
    return {
        id: cleanCell(row.id, 80) || `draft_${index + 1}`,
        sourceSheetId: cleanCell(row.sourceSheetId),
        sourceSheet: cleanCell(row.sourceSheet),
        sourceRow: Number.parseInt(row.sourceRow, 10) || index + 1,
        parseSource: row.parseSource === 'ai' ? 'ai' : 'local',
        grade: cleanCell(row.grade || '默认年级') || '默认年级',
        className: cleanCell(row.className),
        subjectName: cleanCell(row.subjectName),
        subjectCategory,
        explicitSubjectCategory,
        subjectTags,
        teacherName,
        weeklyHours: parseWeeklyHours(row.weeklyHours),
        blockPreference: blockPreference.value,
        rawBlockPreference: blockPreference.raw,
        blockPreferenceDegraded: blockPreference.degraded,
        roomName,
        activityTypes: normalizeTimetableActivityTypes(row.activityTypes || row.activityType),
        requiredResourceTypes: normalizeTimetableResourceTypes(row.requiredResourceTypes || row.resourceTypes),
    };
}

function createIssue(row, severity, field, message) {
    return {
        rowId: row.id,
        sourceSheet: row.sourceSheet || '',
        sourceRow: row.sourceRow,
        severity,
        field,
        message,
    };
}

function rosterStats(rows = [], issues = []) {
    const classes = new Set();
    const teachers = new Set();
    const subjects = new Set();
    const rooms = new Set();
    let totalLessons = 0;
    let blockLessons = 0;

    rows.forEach(row => {
        if (row.className) classes.add(`${row.grade}-${row.className}`);
        if (row.subjectName) subjects.add(row.subjectName);
        splitEntityNames(row.teacherName).forEach(name => teachers.add(name));
        splitEntityNames(row.roomName).forEach(name => rooms.add(name));
        const hours = Number(row.weeklyHours || 0);
        if (hours > 0) totalLessons += hours;
        if (row.blockPreference === 'double') blockLessons += hours;
        if (row.blockPreference === 'mixed') blockLessons += Math.min(2, hours);
    });

    return {
        classCount: classes.size,
        teacherCount: teachers.size,
        subjectCount: subjects.size,
        planCount: rows.length,
        totalLessons,
        blockLessons,
        fixedRoomCount: rooms.size,
        issueCount: issues.length,
    };
}

function analyzeDraftRows(rows = [], project = {}) {
    const draftRows = rows
        .filter(rowHasAnyValue)
        .map(normalizeDraftRow);
    const issues = [];
    const warnings = [];
    const duplicateKeys = new Map();

    draftRows.forEach(row => {
        if (!row.className) issues.push(createIssue(row, 'error', 'className', '请填写班级。'));
        if (!row.subjectName) issues.push(createIssue(row, 'error', 'subjectName', '请填写课程。'));
        if (!row.teacherName) issues.push(createIssue(row, 'error', 'teacherName', '请填写教师。'));
        if (!Number.isInteger(row.weeklyHours) || row.weeklyHours < 1 || row.weeklyHours > 60) {
            issues.push(createIssue(row, 'error', 'weeklyHours', '周课时需要在 1-60 之间。'));
        }
        if (row.blockPreference === 'double' && row.weeklyHours > 0 && row.weeklyHours % 2 !== 0) {
            const issue = createIssue(row, 'warning', 'blockPreference', '双连堂课时建议使用偶数。');
            issues.push(issue);
            warnings.push(issue.message);
        }
        const key = [row.grade, row.className, row.subjectName, row.teacherName].join('|');
        if (duplicateKeys.has(key)) {
            const issue = createIssue(row, 'warning', 'subjectName', '存在重复任课，请确认是否需要合并。');
            issues.push(issue);
            warnings.push(issue.message);
        } else {
            duplicateKeys.set(key, row);
        }
    });

    const activeSlotCount = (project.activeWeekdays?.length || project.weekdays || 5)
        * (project.activePeriods?.length || project.periodsPerDay || 7);
    const classLoads = new Map();
    draftRows.forEach(row => {
        if (!row.className) return;
        const key = `${row.grade}-${row.className}`;
        classLoads.set(key, (classLoads.get(key) || 0) + Number(row.weeklyHours || 0));
    });
    for (const [className, total] of classLoads) {
        if (total > activeSlotCount) {
            const issue = {
                rowId: '',
                sourceRow: null,
                severity: 'warning',
                field: 'weeklyHours',
                message: `${className} 的周课时超过当前可用格子。`,
            };
            issues.push(issue);
            warnings.push(issue.message);
        }
    }

    const rowIssues = new Map();
    issues.forEach(issue => {
        if (!issue.rowId) return;
        if (!rowIssues.has(issue.rowId)) rowIssues.set(issue.rowId, []);
        rowIssues.get(issue.rowId).push(issue);
    });
    const rowsWithIssues = draftRows.map(row => ({
        ...row,
        issues: rowIssues.get(row.id) || [],
    }));

    const result = {
        draftRows: rowsWithIssues,
        stats: rosterStats(draftRows, issues),
        warnings: [...new Set(warnings)],
        issues,
        hasBlockingIssues: issues.some(issue => issue.severity === 'error'),
    };
    result.importReport = buildRosterImportReport(result);
    return result;
}

export function previewTimetableRosterRows(rows = [], { project = {} } = {}) {
    return analyzeDraftRows(rows, project);
}

export function previewTimetableRosterText(text = '', { project = {} } = {}) {
    return localRosterParse(text, project);
}

export function buildTimetableRosterFromRows(rows = [], { project = {} } = {}) {
    const preview = previewTimetableRosterRows(rows, { project });
    if (preview.hasBlockingIssues) {
        const error = new Error('请先修正任课复核表里的红色问题。');
        error.issues = preview.issues;
        throw error;
    }

    const teachers = new Map();
    const classes = new Map();
    const subjects = new Map();
    const rooms = new Map();
    const lessonPlans = [];
    const existingRoomIdsByName = new Map((project.rooms || [])
        .filter(room => room?.name && room?.id)
        .map(room => [cleanCell(room.name), room.id]));

    preview.draftRows.forEach(row => {
        const teacherNames = splitEntityNames(row.teacherName);
        if (!row.className || !row.subjectName || !teacherNames.length || row.weeklyHours <= 0) return;

        const classId = makeTimetableId('c', `${row.grade}-${row.className}`);
        const subjectId = makeTimetableId('s', row.subjectName);
        const teacherIds = teacherNames.map(name => makeTimetableId('t', name));
        const roomNames = splitEntityNames(row.roomName);
        const roomIds = roomNames.map(name => existingRoomIdsByName.get(name) || rosterRoomId(name));
        const roomTags = roomNames.flatMap(roomTagsFromName);
        const subjectCategory = normalizeSubjectCategory(row.subjectCategory);
        const subjectTags = normalizeSubjectTags(row.subjectTags);

        pushUnique(classes, classId, { id: classId, grade: row.grade, name: row.className });
        const subject = pushUnique(subjects, subjectId, {
            id: subjectId,
            name: row.subjectName,
            category: subjectCategory,
            tags: subjectTags,
            priority: subjectCategory === 'main' ? 95 : subjectCategory === 'quality' ? 35 : subjectCategory === 'lab' ? 60 : 50,
            color: PALETTE[subjects.size % PALETTE.length],
        });
        if (subject.category === 'normal' && subjectCategory !== 'normal') subject.category = subjectCategory;
        subjectTags.forEach(tag => {
            if (!subject.tags.includes(tag)) subject.tags.push(tag);
        });
        teacherNames.forEach((name, index) => {
            const teacher = pushUnique(teachers, teacherIds[index], {
                id: teacherIds[index],
                name,
                subjects: [],
                unavailableSlots: [],
            });
            if (!teacher.subjects.includes(subjectId)) teacher.subjects.push(subjectId);
        });
        roomNames.forEach((name, index) => {
            const room = pushUnique(rooms, roomIds[index], {
                id: roomIds[index],
                name,
                tags: roomTagsFromName(name),
            });
            roomTagsFromName(name).forEach(tag => {
                if (!room.tags.includes(tag)) room.tags.push(tag);
            });
        });
        const lessonMetadata = mergeExplicitLessonMetadata(row, roomTags);

        lessonPlans.push({
            id: `lp_${lessonPlans.length + 1}`,
            classId,
            subjectId,
            teacherId: teacherIds[0],
            teacherIds,
            weeklyHours: row.weeklyHours,
            blockPreference: row.blockPreference,
            roomId: roomIds[0] || null,
            allowedRoomIds: roomIds,
            activityTypes: lessonMetadata.activityTypes,
            requiredResourceTypes: lessonMetadata.requiredResourceTypes,
            className: row.className,
            subjectName: row.subjectName,
            teacherName: teacherNames.join('、'),
        });
    });

    return {
        teachers: [...teachers.values()],
        classes: [...classes.values()],
        subjects: [...subjects.values()],
        rooms: [...rooms.values()],
        lessonPlans,
        warnings: preview.warnings,
        issues: preview.issues,
        stats: preview.stats,
        draftRows: preview.draftRows,
        importReport: preview.importReport,
        count: lessonPlans.length,
    };
}

export function parseTimetableRosterText(text = '', options = {}) {
    return buildTimetableRosterFromRows(previewTimetableRosterText(text, options).draftRows, options);
}

function findRosterHeader(sheet = {}) {
    let best = null;
    for (const row of (sheet.rows || []).slice(0, MAX_HEADER_SCAN_ROWS)) {
        const mapping = (row.cells || []).map(normalizeHeader);
        const requiredCount = REQUIRED_ROSTER_FIELDS.filter(field => mapping.includes(field)).length;
        const recognizedCount = mapping.filter(Boolean).length;
        const candidate = { row, mapping, requiredCount, score: requiredCount * 100 + recognizedCount, source: 'local' };
        if (!best || candidate.score > best.score) best = candidate;
    }
    return best;
}

function rowFromSheetMapping(sheet, row, mapping, parseSource = 'local') {
    const draft = {
        id: `draft_${sheet.id}_${row.sourceRow}`,
        sourceSheetId: sheet.id,
        sourceSheet: sheet.name,
        sourceRow: row.sourceRow,
        parseSource,
    };
    mapping.forEach((field, columnIndex) => {
        if (field) draft[field] = row.cells?.[columnIndex] ?? '';
    });
    return draft;
}

function parseMappedSheetRows(sheet, header, parseSource = header?.source || 'local') {
    if (!header?.row || !Array.isArray(header.mapping)) return { rows: [], unresolved: [] };
    const rows = [];
    const unresolved = [];
    for (const sourceRow of sheet.rows || []) {
        if (sourceRow.sourceRow <= header.row.sourceRow) continue;
        const repeatedHeader = (sourceRow.cells || []).map(normalizeHeader);
        if (REQUIRED_ROSTER_FIELDS.every(field => repeatedHeader.includes(field))) continue;
        const draft = rowFromSheetMapping(sheet, sourceRow, header.mapping, parseSource);
        if (!rowHasAnyValue(draft) && !(sourceRow.cells || []).some(Boolean)) continue;
        if (REQUIRED_ROSTER_FIELDS.every(field => cleanCell(draft[field]))) rows.push(draft);
        else unresolved.push({ sourceKey: `${sheet.id}:${sourceRow.sourceRow}`, sheet, sourceRow, draft });
    }
    return { rows, unresolved };
}

function workbookSheetClassification(source = {}) {
    const sheetReviews = [];
    const rows = [];
    const unresolvedRows = [];
    const unresolvedSheets = [];

    for (const sheet of source.sheets || []) {
        const header = findRosterHeader(sheet);
        const base = {
            id: sheet.id,
            name: sheet.name,
            index: sheet.index,
            selected: false,
            status: 'ignored',
            headerRow: header?.row?.sourceRow || null,
            rowCount: 0,
            parseSource: 'none',
            reason: '',
        };
        if (sheet.hidden) {
            sheetReviews.push({ ...base, reason: '隐藏工作表默认不导入。' });
            continue;
        }
        if (!sheet.rows?.length) {
            sheetReviews.push({ ...base, reason: '工作表为空。' });
            continue;
        }
        if (header?.requiredCount === REQUIRED_ROSTER_FIELDS.length) {
            const parsed = parseMappedSheetRows(sheet, header, 'local');
            rows.push(...parsed.rows, ...parsed.unresolved.map(item => item.draft));
            unresolvedRows.push(...parsed.unresolved);
            sheetReviews.push({
                ...base,
                selected: true,
                status: parsed.unresolved.length ? 'review' : 'included',
                rowCount: parsed.rows.length + parsed.unresolved.length,
                parseSource: 'local',
                reason: parsed.unresolved.length ? `有 ${parsed.unresolved.length} 行需要补充或复核。` : '已识别标准任课表头。',
            });
            continue;
        }

        const maxColumns = Math.max(0, ...(sheet.rows || []).map(row => row.cells?.filter(Boolean).length || 0));
        if (sheet.rows.length >= 2 && maxColumns >= 4) {
            unresolvedSheets.push({ sheet, header });
            sheetReviews.push({ ...base, status: 'review', reason: '表头需要智能识别，当前未自动导入。' });
        } else {
            sheetReviews.push({ ...base, reason: '内容不像任课明细表。' });
        }
    }
    return { sheetReviews, rows, unresolvedRows, unresolvedSheets };
}

function appendGlobalPreviewIssues(preview, issues = []) {
    if (!issues.length) return preview;
    preview.issues = [...(preview.issues || []), ...issues];
    const issuesByRow = new Map();
    issues.forEach(issue => {
        if (!issue.rowId) return;
        if (!issuesByRow.has(issue.rowId)) issuesByRow.set(issue.rowId, []);
        issuesByRow.get(issue.rowId).push(issue);
    });
    preview.draftRows = (preview.draftRows || []).map(row => ({
        ...row,
        issues: [...(row.issues || []), ...(issuesByRow.get(row.id) || [])],
    }));
    preview.warnings = [...new Set([...(preview.warnings || []), ...issues.map(issue => issue.message)])];
    preview.hasBlockingIssues = preview.issues.some(issue => issue.severity === 'error');
    preview.stats = { ...(preview.stats || {}), issueCount: preview.issues.length };
    preview.importReport = buildRosterImportReport(preview);
    return preview;
}

function rosterParseSummary(source, sheetReviews, rows, {
    aiAttempted = false,
    aiCallCount = 0,
    unresolvedRowCount = 0,
} = {}) {
    const selected = (sheetReviews || []).filter(sheet => sheet.selected);
    return {
        format: source.format,
        sheetCount: source.sheets?.length || 0,
        includedSheetCount: selected.length,
        includedSheetNames: selected.map(sheet => sheet.name),
        localRowCount: rows.filter(row => row.parseSource !== 'ai').length,
        aiRowCount: rows.filter(row => row.parseSource === 'ai').length,
        unresolvedRowCount,
        aiAttempted,
        aiCallCount,
    };
}

function localWorkbookPreview(source, { project = {} } = {}) {
    const classified = workbookSheetClassification(source);
    const preview = analyzeDraftRows(classified.rows, project);
    const globalIssues = classified.unresolvedSheets.map(({ sheet }) => ({
        rowId: '',
        sourceSheet: sheet.name,
        sourceRow: null,
        severity: 'warning',
        field: 'sheet',
        message: `工作表“${sheet.name}”未识别为任课表，未自动导入。`,
    }));
    appendGlobalPreviewIssues(preview, globalIssues);
    preview.warnings = [...new Set([...(source.warnings || []), ...(preview.warnings || [])])];
    preview.sheetReviews = classified.sheetReviews;
    preview.parseSummary = rosterParseSummary(source, classified.sheetReviews, preview.draftRows, {
        unresolvedRowCount: classified.unresolvedRows.length + classified.unresolvedSheets.reduce((total, item) => total + item.sheet.rowCount, 0),
    });
    preview.source = 'local';
    return preview;
}

function textParseMetadata(format, preview, {
    aiAttempted = false,
    aiCallCount = 0,
    unresolvedRowCount = preview.draftRows?.length ? 0 : 1,
} = {}) {
    return {
        ...preview,
        sheetReviews: [],
        parseSummary: {
            format,
            sheetCount: 0,
            includedSheetCount: 0,
            includedSheetNames: [],
            localRowCount: (preview.draftRows || []).filter(row => row.parseSource !== 'ai').length,
            aiRowCount: (preview.draftRows || []).filter(row => row.parseSource === 'ai').length,
            unresolvedRowCount,
            aiAttempted,
            aiCallCount,
        },
    };
}

export function previewTimetableRosterFile(input = {}, options = {}) {
    const source = readRosterFileSource(input);
    if (source.kind === 'text') {
        const preview = previewTimetableRosterText(source.text, options);
        preview.warnings = [...new Set([...(source.warnings || []), ...(preview.warnings || [])])];
        return textParseMetadata(source.format, { ...preview, source: 'local' });
    }
    return localWorkbookPreview(source, options);
}

export function parseTimetableRosterFile(input = {}, options = {}) {
    const preview = previewTimetableRosterFile(input, options);
    return {
        ...buildTimetableRosterFromRows(preview.draftRows, options),
        warnings: preview.warnings,
        issues: preview.issues,
        stats: preview.stats,
        draftRows: preview.draftRows,
        importReport: preview.importReport,
        source: preview.source,
        sheetReviews: preview.sheetReviews,
        parseSummary: preview.parseSummary,
    };
}

export const TIMETABLE_BLOCK_LABELS = {
    single: blockLabel('single'),
    double: blockLabel('double'),
    mixed: blockLabel('mixed'),
};

// ============================================================
// AI-Driven Roster Parsing
// ============================================================

class RosterAiError extends Error {
    constructor(message, reason = 'ai_unavailable') {
        super(message);
        this.name = 'RosterAiError';
        this.reason = reason;
    }
}

function resolveRosterAiConfig(env = {}) {
    const apiKey = String(env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || '').trim();
    const baseUrl = String(env.DEEPSEEK_API_BASE || env.OPENAI_API_BASE || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
    const model = String(env.DEEPSEEK_MODEL || env.OPENAI_MODEL || 'deepseek-chat').trim();
    if (!apiKey) {
        throw new RosterAiError('AI 解析未配置，请先配置 API Key。', 'ai_not_configured');
    }
    return { apiKey, baseUrl, model };
}

function resolveRosterFetch(fetchImpl) {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof globalThis.fetch === 'function') return globalThis.fetch;
    throw new RosterAiError('运行环境缺少 fetch。', 'missing_fetch');
}

function buildRosterAiPrompt(text, project = {}) {
    const existingTeachers = (project.teachers || []).map(t => t.name).filter(Boolean).slice(0, 50);
    const existingSubjects = (project.subjects || []).map(s => s.name).filter(Boolean).slice(0, 30);
    const existingClasses = (project.classes || []).map(c => c.name).filter(Boolean).slice(0, 30);

    const systemPrompt = [
        '你是一个中国 K-12 学校任课数据提取助手。',
        '用户会粘贴或上传各种格式的任课安排数据(表格、文本、不规则格式)。',
        '你的任务是从中提取结构化的任课数据行。',
        '',
        '## 输出 JSON schema (严格遵守):',
        '```json',
        '{',
        '  "draftRows": [',
        '    {',
        '      "sourceRow": 1,',
        '      "grade": "年级名(如 高一、一年级)",',
        '      "className": "班级名(如 1班、高一(2)班)",',
        '      "subjectName": "科目名(如 语文、数学)",',
        '      "teacherName": "教师姓名",',
        '      "weeklyHours": 4,',
        '      "blockPreference": "single|double|mixed",',
        '      "roomName": "教室名(可选)",',
        '      "subjectCategory": "normal|main|quality|lab",',
        '      "subjectTags": ["课程标签"],',
        '      "activityTypes": ["普通课|实验课|上机课|新授课|复习|答疑|社团或原始学校值"],',
        '      "requiredResourceTypes": ["普通教室|实验室|计算机教室或原始学校值"]',
        '    }',
        '  ],',
        '  "anomalies": [',
        '    { "row": 0, "field": "weeklyHours", "message": "周课时异常高(20),疑似输入错误", "suggestion": "通常为2-6" }',
        '  ]',
        '}',
        '```',
        '',
        '## 规则:',
        '1. grade: 从班级名推断年级(如"高一1班"→grade:"高一",className:"1班")',
        '2. 如果一行包含多个教师(用、/，分隔),拆分为多行',
        '3. weeklyHours 必须是正整数,默认为2,范围1-15',
        '4. blockPreference: "double"=连堂,"single"=单节,"mixed"=混合,默认"single"',
        '5. 识别不规则格式: 合并单元格、跨行数据、备注文字',
        '6. 忽略纯标题/汇总/空行',
        '7. anomalies: 周课时>10标为异常,重复任课标为异常',
        '8. sourceRow 必须使用输入中标注的原始行号，不得自行重新编号',
        '9. activityTypes 和 requiredResourceTypes 保持数组结构；每条任课只提取一个主要课型和一个主要资源标签',
        '10. 保留无法归类的学校自定义原值',
        '11. 只输出 JSON,不要 markdown 包裹,不要解释文字',
        existingTeachers.length ? `\n已知教师: ${existingTeachers.join('、')}` : '',
        existingSubjects.length ? `已知科目: ${existingSubjects.join('、')}` : '',
        existingClasses.length ? `已知班级: ${existingClasses.join('、')}` : '',
    ].filter(Boolean).join('\n');

    return { systemPrompt, userMessage: text };
}

async function callRosterAiJson({ systemPrompt, userMessage, env = {}, fetchImpl, budget = null, maxTokens = 4096 }) {
    if (budget) budget.attempted = true;
    const { apiKey, baseUrl, model } = resolveRosterAiConfig(env);
    const fetchClient = resolveRosterFetch(fetchImpl);
    const input = String(userMessage || '');
    if (input.length > MAX_ROSTER_AI_INPUT_CHARS) {
        throw new RosterAiError(`AI 单次输入不能超过 ${MAX_ROSTER_AI_INPUT_CHARS} 个字符。`, 'ai_input_too_large');
    }
    if (budget) {
        if (budget.calls >= MAX_ROSTER_AI_CALLS) {
            throw new RosterAiError('AI 补充解析已达到单次上传调用上限。', 'ai_call_limit');
        }
        budget.calls += 1;
    }

    const response = await fetchClient(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: input },
            ],
            temperature: 0.1,
            response_format: { type: 'json_object' },
            max_tokens: maxTokens,
        }),
    });

    if (!response.ok) {
        throw new RosterAiError(`AI 服务返回 ${response.status}`, 'ai_request_failed');
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    try {
        const parsed = typeof content === 'string' ? JSON.parse(content) : content;
        return parsed;
    } catch {
        throw new RosterAiError('AI 返回格式异常，无法解析。', 'ai_response_invalid');
    }
}

async function callRosterAi({ text, project, env = {}, fetchImpl, budget = null }) {
    const prompt = buildRosterAiPrompt(text, project);
    return callRosterAiJson({ ...prompt, env, fetchImpl, budget, maxTokens: 8192 });
}

function buildRosterHeaderAiPrompt(sheet = {}) {
    const rows = (sheet.rows || []).slice(0, 8).map(row => ({ row: row.sourceRow, cells: row.cells }));
    return {
        systemPrompt: [
            '你负责识别中国学校任课表的列含义。',
            '只返回 JSON，不提取整张表数据，不修改单元格内容。',
            '允许字段: grade,className,subjectName,teacherName,weeklyHours,blockPreference,roomName,subjectCategory,subjectTags,activityTypes,requiredResourceTypes。',
            '输出格式: {"headerRow":数字,"columnMappings":[{"columnIndex":0,"field":"grade"}],"confidence":0到1}。',
            '必须映射 className、subjectName、teacherName；无法确定时返回空 columnMappings。',
        ].join('\n'),
        userMessage: JSON.stringify({ sheet: sheet.name, rows }),
    };
}

function normalizeAiHeaderResult(result = {}, sheet = {}) {
    const headerRow = Number.parseInt(result.headerRow, 10);
    const row = (sheet.rows || []).find(item => item.sourceRow === headerRow) || sheet.rows?.[0] || null;
    if (!row) return null;
    const mapping = Array.from({ length: row.cells?.length || 0 }, () => null);
    const rawMappings = Array.isArray(result.columnMappings)
        ? result.columnMappings
        : Object.entries(result.columnMappings || {}).map(([columnIndex, field]) => ({ columnIndex, field }));
    rawMappings.forEach(item => {
        const columnIndex = Number.parseInt(item?.columnIndex, 10);
        const field = String(item?.field || '').trim();
        if (Number.isInteger(columnIndex) && columnIndex >= 0 && columnIndex < mapping.length && AI_HEADER_FIELDS.has(field)) {
            mapping[columnIndex] = field;
        }
    });
    if (!REQUIRED_ROSTER_FIELDS.every(field => mapping.includes(field))) return null;
    return { row, mapping, source: 'ai', requiredCount: 3, score: 1_000 };
}

function buildRosterRowAiPrompt(items = []) {
    return {
        systemPrompt: [
            '你负责补全中国学校任课表中缺少必要字段的少量行。',
            '只返回 JSON: {"draftRows":[{"sourceKey":"原值", "grade":"", "className":"", "subjectName":"", "teacherName":"", "weeklyHours":1, "blockPreference":"single", "roomName":""}]}。',
            'sourceKey 必须原样返回。不得改写 knownFields 中已有的非空值；无法确定的行不要输出。',
        ].join('\n'),
        userMessage: JSON.stringify({
            rows: items.map(item => ({
                sourceKey: item.sourceKey,
                sheet: item.sheet.name,
                row: item.sourceRow.sourceRow,
                cells: item.sourceRow.cells,
                knownFields: item.draft,
            })),
        }),
    };
}

function rosterAiBatches(items = []) {
    const batches = [];
    let current = [];
    let currentSize = 0;
    for (const item of items) {
        const itemSize = JSON.stringify(item).length + 2;
        if (current.length && currentSize + itemSize > MAX_ROSTER_AI_INPUT_CHARS - 1_000) {
            batches.push(current);
            current = [];
            currentSize = 0;
        }
        current.push(item);
        currentSize += itemSize;
    }
    if (current.length) batches.push(current);
    return batches;
}

function mergeAiRowWithKnown(aiRow = {}, unresolved) {
    const merged = {
        ...aiRow,
        id: unresolved.draft.id,
        sourceSheetId: unresolved.sheet.id,
        sourceSheet: unresolved.sheet.name,
        sourceRow: unresolved.sourceRow.sourceRow,
        parseSource: 'ai',
    };
    const conflicts = [];
    for (const field of AI_HEADER_FIELDS) {
        const known = unresolved.draft[field];
        const hasKnown = Array.isArray(known) ? known.length > 0 : Boolean(cleanCell(known));
        if (!hasKnown) continue;
        const aiValue = aiRow[field];
        const comparableKnown = Array.isArray(known) ? known.map(cleanCell).join('|') : cleanCell(known);
        const comparableAi = Array.isArray(aiValue) ? aiValue.map(cleanCell).join('|') : cleanCell(aiValue);
        if (comparableAi && comparableAi !== comparableKnown) conflicts.push(field);
        merged[field] = known;
    }
    return { row: merged, conflicts };
}

function normalizeAiRosterRows(parsed = {}) {
    const rows = Array.isArray(parsed.draftRows) ? parsed.draftRows : Array.isArray(parsed) ? parsed : [];
    const anomalies = Array.isArray(parsed.anomalies) ? parsed.anomalies : [];
    return { rows, anomalies };
}

async function parseWorkbookAiOrLocal(source, { project = {}, env = {}, fetchImpl } = {}) {
    const classified = workbookSheetClassification(source);
    const budget = { attempted: false, calls: 0 };
    const unresolvedIds = new Set(classified.unresolvedRows.map(item => item.draft.id));
    const parsedRows = classified.rows.filter(row => !unresolvedIds.has(row.id));
    const unresolvedRows = [...classified.unresolvedRows];
    const unresolvedSheets = [];
    const aiConflictIssues = [];
    let aiFailure = null;

    for (const item of classified.unresolvedSheets) {
        if (aiFailure || budget.calls >= MAX_ROSTER_AI_CALLS) {
            unresolvedSheets.push(item);
            continue;
        }
        try {
            const result = await callRosterAiJson({
                ...buildRosterHeaderAiPrompt(item.sheet),
                env,
                fetchImpl,
                budget,
            });
            const header = normalizeAiHeaderResult(result, item.sheet);
            if (!header) {
                unresolvedSheets.push(item);
                continue;
            }
            const parsed = parseMappedSheetRows(item.sheet, header, 'ai');
            parsedRows.push(...parsed.rows);
            unresolvedRows.push(...parsed.unresolved);
            const review = classified.sheetReviews.find(sheet => sheet.id === item.sheet.id);
            if (review) Object.assign(review, {
                selected: true,
                status: parsed.unresolved.length ? 'review' : 'included',
                headerRow: header.row.sourceRow,
                rowCount: parsed.rows.length + parsed.unresolved.length,
                parseSource: 'ai',
                reason: parsed.unresolved.length ? `AI 已识别表头，仍有 ${parsed.unresolved.length} 行需要复核。` : 'AI 已补充识别表头。',
            });
        } catch (error) {
            aiFailure = error;
            unresolvedSheets.push(item);
        }
    }

    const unresolvedByKey = new Map(unresolvedRows.map(item => [item.sourceKey, item]));
    const resolvedKeys = new Set();
    if (!aiFailure && unresolvedRows.length) {
        for (const batch of rosterAiBatches(unresolvedRows)) {
            if (budget.calls >= MAX_ROSTER_AI_CALLS) break;
            try {
                const result = await callRosterAiJson({
                    ...buildRosterRowAiPrompt(batch),
                    env,
                    fetchImpl,
                    budget,
                });
                const aiRows = Array.isArray(result.draftRows) ? result.draftRows : [];
                for (const aiRow of aiRows) {
                    const sourceKey = String(aiRow?.sourceKey || '').trim();
                    const unresolved = unresolvedByKey.get(sourceKey);
                    if (!unresolved || resolvedKeys.has(sourceKey)) continue;
                    const merged = mergeAiRowWithKnown(aiRow, unresolved);
                    parsedRows.push(merged.row);
                    if (merged.conflicts.length) {
                        aiConflictIssues.push({
                            rowId: unresolved.draft.id,
                            sourceSheet: unresolved.sheet.name,
                            sourceRow: unresolved.sourceRow.sourceRow,
                            severity: 'warning',
                            field: merged.conflicts[0],
                            message: `AI 补充与本地字段冲突(${merged.conflicts.join('、')})，已保留本地值，请复核。`,
                        });
                    }
                    resolvedKeys.add(sourceKey);
                }
            } catch (error) {
                aiFailure = error;
                break;
            }
        }
    }

    const stillUnresolvedRows = unresolvedRows.filter(item => !resolvedKeys.has(item.sourceKey));
    parsedRows.push(...stillUnresolvedRows.map(item => item.draft));
    const preview = analyzeDraftRows(parsedRows, project);
    const globalIssues = [...aiConflictIssues, ...unresolvedSheets.map(({ sheet }) => ({
        rowId: '',
        sourceSheet: sheet.name,
        sourceRow: null,
        severity: 'warning',
        field: 'sheet',
        message: `工作表“${sheet.name}”的表头仍无法识别，未自动导入其中 ${sheet.rowCount} 行。`,
    }))];
    if (aiFailure) {
        globalIssues.push({
            rowId: '',
            sourceSheet: '',
            sourceRow: null,
            severity: 'warning',
            field: 'ai',
            message: `AI 补充解析未完成(${aiFailure.message})，本地结果已保留。`,
        });
    } else if (stillUnresolvedRows.length && budget.calls >= MAX_ROSTER_AI_CALLS) {
        globalIssues.push({
            rowId: '',
            sourceSheet: '',
            sourceRow: null,
            severity: 'warning',
            field: 'ai',
            message: `AI 补充解析达到 ${MAX_ROSTER_AI_CALLS} 次调用上限，剩余行已保留待复核。`,
        });
    }
    appendGlobalPreviewIssues(preview, globalIssues);
    preview.warnings = [...new Set([...(source.warnings || []), ...(preview.warnings || [])])];
    const localRowCount = preview.draftRows.filter(row => row.parseSource !== 'ai').length;
    const aiRowCount = preview.draftRows.filter(row => row.parseSource === 'ai').length;
    preview.source = aiRowCount && localRowCount ? 'mixed' : aiRowCount ? 'ai' : 'local';
    preview.sheetReviews = classified.sheetReviews;
    preview.parseSummary = rosterParseSummary(source, classified.sheetReviews, preview.draftRows, {
        aiAttempted: budget.attempted,
        aiCallCount: budget.calls,
        unresolvedRowCount: stillUnresolvedRows.length + unresolvedSheets.reduce((total, item) => total + item.sheet.rowCount, 0),
    });
    return preview;
}

function rosterTextAiBatches(lines = [], sourceRows = []) {
    const batches = [];
    const oversized = [];
    let current = [];
    let currentSize = 0;
    for (const sourceRow of sourceRows) {
        const item = { sourceRow, text: lines[sourceRow - 1] || '' };
        const formatted = `[第${sourceRow}行] ${item.text}`;
        if (formatted.length > MAX_ROSTER_AI_INPUT_CHARS) {
            oversized.push(item);
            continue;
        }
        if (current.length && (
            current.length >= MAX_ROSTER_AI_BATCH_ROWS
            || currentSize + formatted.length + 1 > MAX_ROSTER_AI_INPUT_CHARS
        )) {
            batches.push(current);
            current = [];
            currentSize = 0;
        }
        current.push(item);
        currentSize += formatted.length + 1;
    }
    if (current.length) batches.push(current);
    return { batches, oversized };
}

function rosterTextBatchMessage(batch = []) {
    return batch.map(item => `[第${item.sourceRow}行] ${item.text}`).join('\n');
}

function normalizeAiTextBatch(result = {}, batch = []) {
    const { rows, anomalies } = normalizeAiRosterRows(result);
    const allowedRows = new Set(batch.map(item => item.sourceRow));
    const canUseOrder = rows.length === batch.length;
    const normalizedRows = [];
    rows.forEach((row, index) => {
        let sourceRow = Number.parseInt(row?.sourceRow, 10);
        if (!allowedRows.has(sourceRow) && canUseOrder) sourceRow = batch[index]?.sourceRow;
        if (!allowedRows.has(sourceRow)) return;
        normalizedRows.push(normalizeDraftRow({ ...row, sourceRow, parseSource: 'ai' }, sourceRow - 1));
    });
    return { rows: normalizedRows, anomalies };
}

async function parseRosterTextAiOrLocal(rawText, {
    format = 'text',
    project = {},
    env = {},
    fetchImpl,
} = {}) {
    const lines = splitRosterInputLines(rawText);
    if (shouldParseRosterAsTable(lines)) {
        const result = { ...analyzeDraftRows(parseRows(lines), project), source: 'local' };
        return textParseMetadata(format, result, { unresolvedRowCount: 0 });
    }

    const localRows = parseNaturalRosterRows(lines, project);
    const localSourceRows = new Set(localRows.map(row => Number(row.sourceRow)));
    if (localRows.length === lines.length) {
        const result = { ...analyzeDraftRows(localRows, project), source: 'local' };
        return textParseMetadata(format, result, { unresolvedRowCount: 0 });
    }

    const unresolvedSourceRows = lines
        .map((_line, index) => index + 1)
        .filter(sourceRow => !localSourceRows.has(sourceRow));
    const { batches, oversized } = rosterTextAiBatches(lines, unresolvedSourceRows);
    const budget = { attempted: false, calls: 0 };
    const aiRows = [];
    const aiAnomalies = [];
    let aiFailure = null;

    for (const batch of batches) {
        if (budget.calls >= MAX_ROSTER_AI_CALLS) break;
        try {
            const result = await callRosterAi({
                text: rosterTextBatchMessage(batch),
                project,
                env,
                fetchImpl,
                budget,
            });
            const normalized = normalizeAiTextBatch(result, batch);
            aiRows.push(...normalized.rows);
            aiAnomalies.push(...normalized.anomalies);
        } catch (error) {
            aiFailure = error;
            break;
        }
    }

    const aiSourceRows = new Set(aiRows.map(row => Number(row.sourceRow)));
    const stillUnresolved = unresolvedSourceRows.filter(sourceRow => !aiSourceRows.has(sourceRow));
    const combinedRows = [...localRows, ...aiRows]
        .sort((left, right) => Number(left.sourceRow) - Number(right.sourceRow));
    const preview = analyzeDraftRows(combinedRows, project);
    const issues = [];

    if (aiFailure) {
        issues.push({
            rowId: '',
            sourceRow: null,
            severity: 'warning',
            field: 'ai',
            message: `AI 补充解析未完成(${aiFailure.message})，已保留本地结果和未识别行。`,
        });
    } else if (batches.length > MAX_ROSTER_AI_CALLS) {
        issues.push({
            rowId: '',
            sourceRow: null,
            severity: 'warning',
            field: 'ai',
            message: `AI 补充解析达到 ${MAX_ROSTER_AI_CALLS} 次调用上限，剩余内容已保留待复核。`,
        });
    }
    oversized.forEach(item => issues.push({
        rowId: '',
        sourceRow: item.sourceRow,
        severity: 'warning',
        field: 'row',
        message: `第 ${item.sourceRow} 行超过 AI 单次输入上限，已保留待复核。`,
    }));
    stillUnresolved.forEach(sourceRow => issues.push({
        rowId: '',
        sourceRow,
        severity: 'warning',
        field: 'row',
        message: `第 ${sourceRow} 行本地未能识别自然语言，AI 也未可靠补全，已保留待复核。`,
    }));
    aiAnomalies.forEach(anomaly => {
        const sourceRow = Number.parseInt(anomaly?.sourceRow ?? anomaly?.row, 10);
        const row = preview.draftRows.find(item => Number(item.sourceRow) === sourceRow);
        if (!row) return;
        issues.push(createIssue(
            row,
            'warning',
            anomaly.field || 'general',
            `${anomaly.message || 'AI 异常检测'}${anomaly.suggestion ? ` — 建议: ${anomaly.suggestion}` : ''}`,
        ));
    });
    appendGlobalPreviewIssues(preview, issues);

    const localRowCount = preview.draftRows.filter(row => row.parseSource !== 'ai').length;
    const aiRowCount = preview.draftRows.filter(row => row.parseSource === 'ai').length;
    preview.source = aiRowCount && localRowCount ? 'mixed' : aiRowCount ? 'ai' : 'local';
    return textParseMetadata(format, preview, {
        aiAttempted: budget.attempted,
        aiCallCount: budget.calls,
        unresolvedRowCount: stillUnresolved.length,
    });
}

export async function parseRosterAiOrLocal({ text = '', file = null, project = {}, env = {}, fetchImpl } = {}) {
    let fileSource = null;
    if (file) {
        fileSource = readRosterFileSource(file);
        if (fileSource.kind === 'workbook') {
            return parseWorkbookAiOrLocal(fileSource, { project, env, fetchImpl });
        }
        text = fileSource.text;
    }

    const rawText = String(text || '');
    if (!rawText.trim()) throw new Error('导入内容为空，请粘贴文本或上传文件。');
    const format = fileSource?.format || 'text';
    return parseRosterTextAiOrLocal(rawText, { format, project, env, fetchImpl });
}

function localRosterParse(text, project) {
    const lines = splitRosterInputLines(text);
    if (shouldParseRosterAsTable(lines)) {
        return analyzeDraftRows(parseRows(lines), project);
    }
    const naturalRows = parseNaturalRosterRows(lines, project);
    if (naturalRows.length) {
        const preview = analyzeDraftRows(naturalRows, project);
        const recognized = new Set(naturalRows.map(row => Number(row.sourceRow)));
        const unresolved = lines
            .map((_line, index) => index + 1)
            .filter(sourceRow => !recognized.has(sourceRow))
            .map(sourceRow => ({
                rowId: '',
                sourceRow,
                severity: 'warning',
                field: 'row',
                message: `第 ${sourceRow} 行本地未能识别自然语言，已保留待复核。`,
            }));
        return appendGlobalPreviewIssues(preview, unresolved);
    }
    return unrecognizedRosterTextResult(project);
}
