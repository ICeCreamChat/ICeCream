import path from 'node:path';

import AdmZip from 'adm-zip';

import { makeTimetableId } from './timetable-scheduler.js';

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
        .replace(/[|｜]/g, ',')
        .split(/\t+|[,，;；]+/)
        .map(cleanCell);
}

function normalizeHeader(value) {
    const text = cleanCell(value).toLowerCase();
    if (/年级|grade/.test(text)) return 'grade';
    if (/班级|class/.test(text)) return 'className';
    if (/课程|科目|学科|subject|course/.test(text)) return 'subjectName';
    if (/教师|老师|teacher/.test(text)) return 'teacherName';
    if (/课时|周课时|hours|hour/.test(text)) return 'weeklyHours';
    if (/连堂|块|block/.test(text)) return 'blockPreference';
    return null;
}

function parseBlockPreference(value) {
    const text = cleanCell(value);
    if (/双|连/.test(text)) return 'double';
    if (/混|单双/.test(text)) return 'mixed';
    return 'single';
}

function parseWeeklyHours(value) {
    const text = cleanCell(value);
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
        header = ['grade', 'className', 'subjectName', 'teacherName', 'weeklyHours', 'blockPreference'];
        start = 0;
    }

    const result = [];
    for (const parts of rows.slice(start)) {
        const row = {};
        header.forEach((key, index) => {
            if (key) row[key] = parts[index];
        });
        if (row.className && row.subjectName && row.teacherName) result.push(row);
    }
    return result;
}

export function parseTimetableRosterText(text = '') {
    const lines = String(text)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    const rows = parseRows(lines);
    const teachers = new Map();
    const classes = new Map();
    const subjects = new Map();
    const lessonPlans = [];
    const warnings = [];

    rows.forEach((row, index) => {
        const grade = cleanCell(row.grade || '默认年级') || '默认年级';
        const className = cleanCell(row.className);
        const subjectName = cleanCell(row.subjectName);
        const teacherName = cleanCell(row.teacherName);
        const weeklyHours = parseWeeklyHours(row.weeklyHours);
        const blockPreference = parseBlockPreference(row.blockPreference);

        if (!weeklyHours) {
            warnings.push(`第 ${index + 1} 行没有有效周课时，已跳过`);
            return;
        }

        const classId = makeTimetableId('c', `${grade}-${className}`);
        const subjectId = makeTimetableId('s', subjectName);
        const teacherId = makeTimetableId('t', teacherName);

        pushUnique(classes, classId, { id: classId, grade, name: className });
        pushUnique(subjects, subjectId, {
            id: subjectId,
            name: subjectName,
            priority: /语文|数学|英语|外语/.test(subjectName) ? 95 : 50,
            color: PALETTE[subjects.size % PALETTE.length],
        });
        const teacher = pushUnique(teachers, teacherId, { id: teacherId, name: teacherName, subjects: [], unavailableSlots: [] });
        if (!teacher.subjects.includes(subjectId)) teacher.subjects.push(subjectId);

        lessonPlans.push({
            id: `lp_${lessonPlans.length + 1}`,
            classId,
            subjectId,
            teacherId,
            weeklyHours,
            blockPreference,
            className,
            subjectName,
            teacherName,
        });
    });

    return {
        teachers: [...teachers.values()],
        classes: [...classes.values()],
        subjects: [...subjects.values()],
        lessonPlans,
        warnings,
        count: lessonPlans.length,
    };
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

function xlsxToText(buffer) {
    const zip = new AdmZip(buffer);
    const sharedStrings = parseSharedStrings(readEntry(zip, 'xl/sharedStrings.xml'));
    const sheetEntry = zip.getEntries().find(entry => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.entryName));
    if (!sheetEntry) return '';
    return worksheetToText(zip.readAsText(sheetEntry, 'utf8'), sharedStrings);
}

export function parseTimetableRosterFile({ buffer, filename = '' } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length <= 0) throw new Error('导入文件为空');
    if (buffer.length > MAX_IMPORT_BYTES) throw new Error('导入文件不能超过 5MB');

    const ext = path.extname(filename).toLowerCase();
    const text = ext === '.xlsx' || ext === '.xls'
        ? xlsxToText(buffer)
        : buffer.toString('utf8');
    return parseTimetableRosterText(text);
}
