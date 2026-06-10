import path from 'node:path';

import AdmZip from 'adm-zip';

import {
    makeTimetableId,
    normalizeSubjectCategory,
    normalizeSubjectTags,
} from './timetable-scheduler.js';

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const PALETTE = ['#14b8a6', '#60a5fa', '#f59e0b', '#f97316', '#a78bfa', '#22c55e', '#ef4444', '#06b6d4'];

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

function parseBlockPreference(value) {
    const text = cleanCell(value).toLowerCase();
    if (!text) return 'single';
    if (['double', 'block', '2'].includes(text) || /双|连堂|double|block/.test(text)) return 'double';
    if (['mixed', 'mix'].includes(text) || /混|单双|mixed|mix/.test(text)) return 'mixed';
    return 'single';
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
    return match ? Number(match[0]) : 0;
}

function pushUnique(map, key, value) {
    if (!map.has(key)) map.set(key, value);
    return map.get(key);
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
        blockPreference: parseBlockPreference(row.blockPreference),
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

    return {
        draftRows: rowsWithIssues,
        stats: rosterStats(draftRows, issues),
        warnings: [...new Set(warnings)],
        issues,
        hasBlockingIssues: issues.some(issue => issue.severity === 'error'),
    };
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
