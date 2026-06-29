/**
 * timetable-v2 / importers / file-input.js
 *
 * HTTP 文件输入适配层：把上传的 CSV/TSV/TXT/JSON/XLSX 文件转换成现有
 * importer 已支持的纯数据形态。这里不构造 SchoolProjectV2，只做安全读取
 * 与格式转换。
 */

import path from 'node:path';

import AdmZip from 'adm-zip';

const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.csv', '.tsv', '.txt']);
const JSON_EXTENSIONS = new Set(['.json']);
const EXCEL_EXTENSIONS = new Set(['.xlsx', '.xls']);
const JSON_SOURCES = new Set(['legacy', 'crystal', 'yqd']);

function cleanCell(value) {
    return String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
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
        const parts = [...cellXml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
            .map(match => decodeXml(match[1]));
        return cleanCell(parts.join(''));
    }
    const value = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
    return cleanCell(decodeXml(value));
}

function worksheetToRows(xml, sharedStrings) {
    const rows = [];
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
        if (row.some(Boolean)) rows.push(row);
    }
    return rows;
}

function xlsxToRows(buffer) {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    if (entries.length > 300) throw new Error('Excel 文件结构过大，无法安全解析');

    const sharedStrings = parseSharedStrings(readEntry(zip, 'xl/sharedStrings.xml'));
    const sheetEntry = entries
        .filter(entry => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.entryName))
        .sort((a, b) => a.entryName.localeCompare(b.entryName))[0];
    if (!sheetEntry) throw new Error('Excel 文件中没有可读取的工作表');

    const rows = worksheetToRows(zip.readAsText(sheetEntry, 'utf8'), sharedStrings);
    if (!rows.length) throw new Error('Excel 工作表为空');
    return rows;
}

function htmlTableToRows(text = '') {
    const rows = [];
    const rowRegex = /<tr\b[\s\S]*?<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(text)) !== null) {
        const cells = [...rowMatch[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
            .map(match => cleanCell(decodeXml(match[1].replace(/<[^>]+>/g, ''))));
        if (cells.some(Boolean)) rows.push(cells);
    }
    return rows;
}

function parseOptions(options) {
    if (!options) return {};
    if (typeof options === 'object') return options;
    try {
        const parsed = JSON.parse(String(options));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function normalizeSource(source) {
    const value = String(source || '').trim().toLowerCase();
    if (value === 'xlsx' || value === 'xls' || value === 'csv' || value === 'tsv') return 'excel';
    return value;
}

function dataFromTextFile(text, source, ext) {
    if (JSON_SOURCES.has(source) || JSON_EXTENSIONS.has(ext)) {
        return JSON.parse(text);
    }
    return text;
}

export function prepareTimetableImportPayload({ source, data, options, file } = {}) {
    const parsedOptions = parseOptions(options);
    const requestedSource = String(source || '').trim().toLowerCase();
    const normalizedSource = normalizeSource(requestedSource);

    if (!file) {
        if (requestedSource === 'xlsx' || requestedSource === 'xls') {
            throw new Error('请选择要导入的 Excel 文件');
        }
        return { source: normalizedSource, data, options: parsedOptions };
    }

    if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
        throw new Error('上传文件为空');
    }
    if (file.buffer.length > MAX_IMPORT_BYTES) {
        throw new Error('导入文件过大，限制 8MB');
    }

    const filename = file.originalname || 'upload';
    const ext = path.extname(filename).toLowerCase();
    if (![...TEXT_EXTENSIONS, ...JSON_EXTENSIONS, ...EXCEL_EXTENSIONS].includes(ext)) {
        throw new Error('不支持的导入文件类型，请使用 .xlsx、.csv、.tsv、.txt 或 .json');
    }

    if (ext === '.xlsx' || file.buffer.subarray(0, 2).toString('utf8') === 'PK') {
        return {
            source: 'excel',
            data: xlsxToRows(file.buffer),
            options: { ...parsedOptions, fileName: filename, fileSource: 'xlsx' },
        };
    }

    const text = file.buffer.toString('utf8');
    if (ext === '.xls') {
        const rows = htmlTableToRows(text);
        if (!rows.length) throw new Error('暂不支持旧版二进制 .xls，请另存为 .xlsx 后导入');
        return {
            source: 'excel',
            data: rows,
            options: { ...parsedOptions, fileName: filename, fileSource: 'xls-text' },
        };
    }

    return {
        source: normalizedSource || (JSON_EXTENSIONS.has(ext) ? 'legacy' : 'excel'),
        data: dataFromTextFile(text, normalizedSource, ext),
        options: { ...parsedOptions, fileName: filename, fileSource: ext.slice(1) },
    };
}
