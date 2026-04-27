import path from 'node:path';

import AdmZip from 'adm-zip';

const MAX_ROSTER_BYTES = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.csv', '.txt']);
const EXCEL_EXTENSIONS = new Set(['.xlsx', '.xls']);

function cleanCell(value) {
    return String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function splitRosterLine(line) {
    return line
        .split(/\t+|[,，;；]+|\s+/)
        .map(cleanCell)
        .filter(Boolean);
}

function normalizeGender(value) {
    const text = cleanCell(value).toLowerCase();
    if (['男', 'm', 'male', 'boy'].includes(text)) return 'M';
    if (['女', 'f', 'female', 'girl'].includes(text)) return 'F';
    return undefined;
}

function isHeaderRow(parts) {
    const joined = parts.join('|').toLowerCase();
    return /姓名|名字|学生|name/.test(joined) && /性别|gender|成绩|分数|grade|身高|height/.test(joined);
}

function parseStudentLine(line, index) {
    const parts = splitRosterLine(line);
    if (!parts.length || isHeaderRow(parts)) return null;

    let name = parts[0].replace(/[（(]\s*[男女mf]\s*[）)]$/i, '').trim().substring(0, 20);
    if (!name || isHeaderRow([name])) return null;

    let gender = normalizeGender(parts[0].match(/[（(]\s*([男女mf])\s*[）)]/i)?.[1]);
    let grade;
    let height;

    for (const part of parts.slice(1)) {
        const parsedGender = normalizeGender(part);
        if (parsedGender) {
            gender = parsedGender;
            continue;
        }

        if (/^\d+(\.\d+)?$/.test(part)) {
            const num = Number(part);
            if (num >= 120 && num <= 230 && height == null) {
                height = num;
            } else if (grade == null) {
                grade = num;
            }
        }
    }

    return {
        id: `s${String(index + 1).padStart(2, '0')}`,
        name,
        gender,
        grade,
        height,
    };
}

export function parseStudentsText(text = '') {
    const lines = String(text)
        .split(/[\r\n]+/)
        .map(line => line.trim())
        .filter(Boolean);
    const students = [];

    for (const line of lines) {
        const student = parseStudentLine(line, students.length);
        if (student) students.push(student);
    }

    return { students, count: students.length };
}

function decodeXml(value = '') {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function readEntry(zip, name) {
    const entry = zip.getEntry(name);
    return entry ? zip.readAsText(entry, 'utf8') : '';
}

function parseAttributes(source = '') {
    const attrs = {};
    const attrRegex = /([A-Za-z_:][\w:.-]*)="([^"]*)"/g;
    let match;
    while ((match = attrRegex.exec(source)) !== null) {
        attrs[match[1]] = decodeXml(match[2]);
    }
    return attrs;
}

function parseSharedStrings(xml = '') {
    const values = [];
    const siRegex = /<si\b[\s\S]*?<\/si>/g;
    let match;
    while ((match = siRegex.exec(xml)) !== null) {
        const textParts = [...match[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
            .map(part => decodeXml(part[1]));
        values.push(textParts.join(''));
    }
    return values;
}

function columnIndex(cellRef = '') {
    const letters = cellRef.match(/[A-Z]+/i)?.[0]?.toUpperCase();
    if (!letters) return null;
    let value = 0;
    for (const letter of letters) {
        value = value * 26 + (letter.charCodeAt(0) - 64);
    }
    return value - 1;
}

function cellText(cellXml, sharedStrings) {
    const openTag = cellXml.match(/^<c\b([^>]*)>/)?.[1] || '';
    const attrs = parseAttributes(openTag);
    if (attrs.t === 's') {
        const raw = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        return cleanCell(sharedStrings[Number(raw)] ?? '');
    }
    if (attrs.t === 'inlineStr') {
        const parts = [...cellXml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1]));
        return cleanCell(parts.join(''));
    }
    const value = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
    return cleanCell(decodeXml(value));
}

function worksheetToText(xml, sharedStrings) {
    const lines = [];
    const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(xml)) !== null) {
        const cellsByColumn = new Map();
        const cellRegex = /<c\b[\s\S]*?<\/c>/g;
        let cellMatch;
        let fallbackCol = 0;
        while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
            const ref = cellMatch[0].match(/^<c\b[^>]*\br="([^"]+)"/)?.[1];
            const col = columnIndex(ref) ?? fallbackCol;
            cellsByColumn.set(col, cellText(cellMatch[0], sharedStrings));
            fallbackCol++;
        }
        const maxCol = Math.max(-1, ...cellsByColumn.keys());
        const row = [];
        for (let col = 0; col <= maxCol; col++) row.push(cellsByColumn.get(col) || '');
        const compact = row.map(cleanCell);
        if (compact.some(Boolean)) lines.push(compact.join('\t'));
    }
    return lines.join('\n');
}

function parseHtmlTableText(text) {
    const rows = [];
    const rowRegex = /<tr\b[\s\S]*?<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(text)) !== null) {
        const cells = [...rowMatch[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
            .map(match => cleanCell(decodeXml(match[1].replace(/<[^>]+>/g, ''))));
        if (cells.some(Boolean)) rows.push(cells.join('\t'));
    }
    return rows.join('\n');
}

function xlsxToText(buffer) {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    if (entries.length > 250) throw new Error('Excel 文件结构过大，无法安全解析');

    const sharedStrings = parseSharedStrings(readEntry(zip, 'xl/sharedStrings.xml'));
    const sheetEntry = entries
        .filter(entry => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.entryName))
        .sort((a, b) => a.entryName.localeCompare(b.entryName))[0];
    if (!sheetEntry) throw new Error('Excel 文件中没有可读取的工作表');

    return worksheetToText(zip.readAsText(sheetEntry, 'utf8'), sharedStrings);
}

export async function parseRosterFile({ buffer, originalname = '', mimetype = '' }) {
    if (!Buffer.isBuffer(buffer)) throw new Error('名单文件为空');
    if (buffer.length > MAX_ROSTER_BYTES) throw new Error('名单文件过大，限制 5MB');

    const ext = path.extname(originalname).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext) && !EXCEL_EXTENSIONS.has(ext)) {
        throw new Error('不支持的名单文件类型');
    }

    let text;
    let source;
    if (TEXT_EXTENSIONS.has(ext)) {
        text = buffer.toString('utf8');
        source = 'text';
    } else if (buffer.subarray(0, 2).toString('utf8') === 'PK') {
        text = xlsxToText(buffer);
        source = 'xlsx';
    } else {
        const maybeText = buffer.toString('utf8');
        text = /<table|<tr|<td|<th/i.test(maybeText) ? parseHtmlTableText(maybeText) : maybeText;
        source = ext === '.xls' ? 'xls-text' : 'text';
    }

    const parsed = parseStudentsText(text);
    if (parsed.count === 0) throw new Error('未识别到学生名单');
    return { ...parsed, source, mimetype };
}
