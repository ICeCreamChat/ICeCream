import path from 'node:path';

import AdmZip from 'adm-zip';

import {
    makeTimetableId,
    normalizeSubjectCategory,
    normalizeSubjectTags,
} from './timetable-scheduler.js';

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const PALETTE = ['#14b8a6', '#60a5fa', '#f59e0b', '#f97316', '#a78bfa', '#22c55e', '#ef4444', '#06b6d4'];
const COMMON_ROSTER_SUBJECTS = [
    '道德与法治', '信息技术', '综合实践', '劳动技术', '心理健康',
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
        const rowSource = { row: row.sourceRow || null, rowId: row.id || null };
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
                source: { row: issue.sourceRow || null, rowId: null },
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
    const parts = splitLine(line).filter(Boolean);
    return parts.length >= 4;
}

function shouldParseRosterAsTable(lines = []) {
    if (!lines.length) return false;
    if (hasRosterHeaderLine(lines[0])) return true;
    return lines.every(isTableLikeRosterLine);
}

function extractNaturalClass(text = '') {
    const gradePattern = '(G\\d+|g\\d+|[零〇一二两三四五六七八九十\\d]+年级|[初高][一二三123])';
    const match = cleanCell(text).match(new RegExp(`${gradePattern}\\s*[-_－—]?\\s*([零〇一二两三四五六七八九十\\d]+)\\s*班`));
    if (!match) return null;
    return {
        grade: match[1],
        className: `${match[2]}班`,
        rest: text.slice(match.index + match[0].length),
    };
}

function extractNaturalWeeklyHours(text = '') {
    const match = cleanCell(text).match(/(?:每周|一周|周课时|周课|每星期|一星期)\s*([零〇一二两三四五六七八九十\d]+)\s*(?:节|课时)?/);
    return match ? parseChineseInteger(match[1]) : 0;
}

function extractNaturalBlockPreference(text = '') {
    const value = cleanCell(text);
    if (/混合|单双|单节和连堂/.test(value)) return 'mixed';
    if (/双连堂|连堂|连续\s*(?:2|两|二)\s*节/.test(value)) return 'double';
    if (/单节|不要连堂|不连堂/.test(value)) return 'single';
    return 'single';
}

function extractNaturalRoom(text = '') {
    const roomPattern = /(实验室|教室|机房|电脑房|体育馆|操场|音乐室|美术室|舞蹈室|功能室|专用教室|场馆|礼堂)$/;
    const segments = cleanCell(text)
        .split(/[，,。；;]/)
        .map(segment => cleanCell(segment).replace(/^(?:安排)?(?:在|到|使用)/, ''))
        .filter(Boolean);
    const segment = segments.find(item => roomPattern.test(item) && !/(老师|每周|一周|周课时|周课|节)/.test(item));
    if (segment) return segment;
    const match = cleanCell(text).match(/(?:安排)?(?:在|到|使用)\s*([^，,。；;\s]*(?:实验室|教室|机房|电脑房|体育馆|操场|音乐室|美术室|舞蹈室|功能室|专用教室|场馆|礼堂))/);
    return match ? cleanCell(match[1]) : '';
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
    return {
        sourceRow: index + 1,
        grade: classInfo.grade,
        className: classInfo.className,
        subjectName: subject.name,
        teacherName,
        weeklyHours,
        blockPreference: extractNaturalBlockPreference(text),
        roomName: extractNaturalRoom(text),
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
    ].some(value => cleanCell(value));
}

function normalizeDraftRow(row = {}, index = 0) {
    const teacherName = splitEntityNames(row.teacherName).join('、');
    const roomName = splitEntityNames(row.roomName || row.roomId || row.allowedRoomIds).join('、');
    const subjectCategory = normalizeSubjectCategory(row.subjectCategory || row.category || row.subjectType, row.subjectName);
    const subjectTags = normalizeSubjectTags(row.subjectTags || row.tags);
    const blockPreference = parseBlockPreferenceInfo(row.blockPreference);
    return {
        id: cleanCell(row.id, 80) || `draft_${index + 1}`,
        sourceRow: Number.parseInt(row.sourceRow, 10) || index + 1,
        grade: cleanCell(row.grade || '默认年级') || '默认年级',
        className: cleanCell(row.className),
        subjectName: cleanCell(row.subjectName),
        subjectCategory,
        subjectTags,
        teacherName,
        weeklyHours: parseWeeklyHours(row.weeklyHours),
        blockPreference: blockPreference.value,
        rawBlockPreference: blockPreference.raw,
        blockPreferenceDegraded: blockPreference.degraded,
        roomName,
    };
}

function createIssue(row, severity, field, message) {
    return {
        rowId: row.id,
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
    const lines = String(text)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    return analyzeDraftRows(parseRows(lines), project);
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
    const lessonPlans = [];

    preview.draftRows.forEach(row => {
        const teacherNames = splitEntityNames(row.teacherName);
        if (!row.className || !row.subjectName || !teacherNames.length || row.weeklyHours <= 0) return;

        const classId = makeTimetableId('c', `${row.grade}-${row.className}`);
        const subjectId = makeTimetableId('s', row.subjectName);
        const teacherIds = teacherNames.map(name => makeTimetableId('t', name));
        const roomNames = splitEntityNames(row.roomName);
        const subjectCategory = normalizeSubjectCategory(row.subjectCategory, row.subjectName);
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

        lessonPlans.push({
            id: `lp_${lessonPlans.length + 1}`,
            classId,
            subjectId,
            teacherId: teacherIds[0],
            teacherIds,
            weeklyHours: row.weeklyHours,
            blockPreference: row.blockPreference,
            roomId: roomNames[0] || null,
            allowedRoomIds: roomNames,
            className: row.className,
            subjectName: row.subjectName,
            teacherName: teacherNames.join('、'),
        });
    });

    return {
        teachers: [...teachers.values()],
        classes: [...classes.values()],
        subjects: [...subjects.values()],
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

function readEntry(zip, name) {
    const entry = zip.getEntry(name);
    return entry ? zip.readAsText(entry, 'utf8') : '';
}

function parseSharedStrings(xml = '') {
    const values = [];
    for (const match of xml.matchAll(/<si[\s\S]*?<\/si>/g)) {
        const text = [...match[0].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
            .map(item => item[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
            .join('');
        values.push(cleanCell(text));
    }
    return values;
}

function columnIndex(ref = '') {
    const letters = String(ref).replace(/\d+/g, '');
    let index = 0;
    for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
    return index - 1;
}

function worksheetToText(xml = '', sharedStrings = []) {
    const lines = [];
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [];
        for (const cellMatch of rowMatch[1].matchAll(/<c[^>]*r="([A-Z]+\d+)"[^>]*>([\s\S]*?)<\/c>/g)) {
            const ref = cellMatch[1];
            const cellXml = cellMatch[0];
            const value = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '';
            const text = /t="s"/.test(cellXml) ? sharedStrings[Number(value)] : value;
            cells[columnIndex(ref)] = cleanCell(text);
        }
        if (cells.some(Boolean)) lines.push(cells.join(','));
    }
    return lines.join('\n');
}

function fileToText({ buffer, filename = '' } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length <= 0) throw new Error('导入文件为空');
    if (buffer.length > MAX_IMPORT_BYTES) throw new Error('导入文件不能超过 5MB');

    const ext = path.extname(filename).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') {
        const zip = new AdmZip(buffer);
        const sharedStrings = parseSharedStrings(readEntry(zip, 'xl/sharedStrings.xml'));
        const sheetEntry = zip.getEntries().find(entry => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.entryName));
        if (!sheetEntry) return '';
        return worksheetToText(zip.readAsText(sheetEntry, 'utf8'), sharedStrings);
    }
    return buffer.toString('utf8');
}

export function previewTimetableRosterFile(input = {}, options = {}) {
    return previewTimetableRosterText(fileToText(input), options);
}

export function parseTimetableRosterFile(input = {}, options = {}) {
    return parseTimetableRosterText(fileToText(input), options);
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
        '      "grade": "年级名(如 高一、一年级)",',
        '      "className": "班级名(如 1班、高一(2)班)",',
        '      "subjectName": "科目名(如 语文、数学)",',
        '      "teacherName": "教师姓名",',
        '      "weeklyHours": 4,',
        '      "blockPreference": "single|double|mixed",',
        '      "roomName": "教室名(可选)",',
        '      "subjectCategory": "core|elective|activity"',
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
        '8. 只输出 JSON,不要 markdown 包裹,不要解释文字',
        existingTeachers.length ? `\n已知教师: ${existingTeachers.join('、')}` : '',
        existingSubjects.length ? `已知科目: ${existingSubjects.join('、')}` : '',
        existingClasses.length ? `已知班级: ${existingClasses.join('、')}` : '',
    ].filter(Boolean).join('\n');

    return { systemPrompt, userMessage: text };
}

async function callRosterAi({ text, project, env = {}, fetchImpl }) {
    const { apiKey, baseUrl, model } = resolveRosterAiConfig(env);
    const fetchClient = resolveRosterFetch(fetchImpl);
    const { systemPrompt, userMessage } = buildRosterAiPrompt(text, project);

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
                { role: 'user', content: userMessage.slice(0, 12000) },
            ],
            temperature: 0.1,
            response_format: { type: 'json_object' },
            max_tokens: 4096,
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

function normalizeAiRosterRows(parsed = {}) {
    const rows = Array.isArray(parsed.draftRows) ? parsed.draftRows : Array.isArray(parsed) ? parsed : [];
    const anomalies = Array.isArray(parsed.anomalies) ? parsed.anomalies : [];
    return { rows, anomalies };
}

export async function parseRosterAiOrLocal({ text = '', file = null, project = {}, env = {}, fetchImpl } = {}) {
    const rawText = file ? fileToText(file) : text;
    if (!rawText.trim()) {
        throw new Error('导入内容为空，请粘贴文本或上传文件。');
    }

    try {
        const aiResult = await callRosterAi({ text: rawText, project, env, fetchImpl });
        const { rows: aiRows, anomalies } = normalizeAiRosterRows(aiResult);
        if (!aiRows.length) {
            // AI returned empty — fall back to local
            return { ...localRosterParse(rawText, project), source: 'local', aiEmpty: true };
        }
        const normalized = aiRows.map((row, index) => normalizeDraftRow(row, index));
        const analysis = analyzeDraftRows(normalized, project);
        // Merge AI anomalies as extra issues
        anomalies.forEach(anomaly => {
            const rowIndex = Number(anomaly.row) || 0;
            const targetRow = analysis.draftRows[rowIndex] || analysis.draftRows[0];
            if (targetRow) {
                analysis.issues.push(createIssue(
                    targetRow,
                    'warning',
                    anomaly.field || 'general',
                    `${anomaly.message || 'AI 异常检测'}${anomaly.suggestion ? ` — 建议: ${anomaly.suggestion}` : ''}`,
                ));
            }
        });
        analysis.importReport = buildRosterImportReport(analysis);
        return { ...analysis, source: 'ai' };
    } catch (error) {
        if (error instanceof RosterAiError && ['ai_not_configured', 'missing_fetch'].includes(error.reason)) {
            return { ...localRosterParse(rawText, project), source: 'local' };
        }
        // Non-config AI errors: still fall back to local with a warning
        const result = localRosterParse(rawText, project);
        result.warnings = [...(result.warnings || []), `AI 解析失败(${error.message})，已使用本地解析。`];
        result.source = 'local';
        return result;
    }
}

function localRosterParse(text, project) {
    const lines = splitRosterInputLines(text);
    if (shouldParseRosterAsTable(lines)) {
        return analyzeDraftRows(parseRows(lines), project);
    }
    const naturalRows = parseNaturalRosterRows(lines, project);
    if (naturalRows.length) {
        return analyzeDraftRows(naturalRows, project);
    }
    return unrecognizedRosterTextResult(project);
}
