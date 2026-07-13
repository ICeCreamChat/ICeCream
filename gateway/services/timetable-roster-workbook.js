import path from 'node:path';
import * as XLSX from '@e965/xlsx';

export const ROSTER_FILE_LIMITS = Object.freeze({
    maxBytes: 5 * 1024 * 1024,
    maxSheets: 20,
    maxRowsPerSheet: 10_000,
    maxColumnsPerSheet: 100,
    maxNonEmptyCells: 100_000,
});

const XLSX_MAGIC = Buffer.from([0x50, 0x4B]);
const XLS_MAGIC = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
const TEXT_EXTENSIONS = new Set(['.csv', '.txt']);
const WORKBOOK_EXTENSIONS = new Set(['.xlsx', '.xls']);

function startsWith(buffer, signature) {
    return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
}

function decodeTextBuffer(buffer) {
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
        return buffer.subarray(3).toString('utf8');
    }
    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
        return buffer.subarray(2).toString('utf16le');
    }
    if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
        const swapped = Buffer.allocUnsafe(buffer.length - 2);
        for (let index = 2; index + 1 < buffer.length; index += 2) {
            swapped[index - 2] = buffer[index + 1];
            swapped[index - 1] = buffer[index];
        }
        return swapped.toString('utf16le');
    }
    return buffer.toString('utf8');
}

function expectedFormatForExtension(extension) {
    if (extension === '.xlsx') return 'xlsx';
    if (extension === '.xls') return 'xls';
    if (extension === '.csv') return 'csv';
    if (extension === '.txt') return 'txt';
    return '';
}

export function detectRosterFileFormat(buffer, filename = '') {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('导入文件为空');
    if (buffer.length > ROSTER_FILE_LIMITS.maxBytes) throw new Error('导入文件不能超过 5MB');

    const extension = path.extname(filename).toLowerCase();
    const expected = expectedFormatForExtension(extension);
    let format = '';
    if (startsWith(buffer, XLS_MAGIC)) format = 'xls';
    else if (startsWith(buffer, XLSX_MAGIC)) format = 'xlsx';
    else if (TEXT_EXTENSIONS.has(extension) || !extension) format = expected || 'txt';

    if (!format) {
        if (WORKBOOK_EXTENSIONS.has(extension)) {
            throw new Error(`文件内容不是有效的 ${extension.slice(1).toUpperCase()} 工作簿，可能已损坏或经过加密。`);
        }
        throw new Error('仅支持 .csv、.txt、.xlsx 或 .xls 任课文件。');
    }

    const warnings = [];
    if (expected && expected !== format && WORKBOOK_EXTENSIONS.has(extension)) {
        warnings.push(`文件扩展名为 ${extension}，实际内容为 ${format.toUpperCase()}，已按实际格式解析。`);
    }
    return { format, extension, warnings };
}

function workbookReadError(error, format) {
    const detail = String(error?.message || error || '').trim();
    if (/password|encrypt|crypto/i.test(detail)) {
        return new Error('任课工作簿已加密，请取消密码保护后重新上传。');
    }
    return new Error(`无法读取 ${format.toUpperCase()} 任课工作簿，文件可能已损坏或格式不受支持。`);
}

function rangeForSheet(sheet = {}) {
    const reference = sheet['!fullref'] || sheet['!ref'];
    if (!reference) return null;
    try {
        return XLSX.utils.decode_range(reference);
    } catch {
        return null;
    }
}

function materializeMergedCells(sheet = {}) {
    const merges = Array.isArray(sheet['!merges']) ? sheet['!merges'] : [];
    if (!merges.length) return sheet;
    const materialized = { ...sheet };
    for (const merge of merges) {
        if (merge.e.r >= ROSTER_FILE_LIMITS.maxRowsPerSheet || merge.e.c >= ROSTER_FILE_LIMITS.maxColumnsPerSheet) {
            throw new Error('工作表合并单元格范围超过任课导入限制。');
        }
        const anchor = sheet[XLSX.utils.encode_cell(merge.s)];
        if (!anchor) continue;
        for (let row = merge.s.r; row <= merge.e.r; row += 1) {
            for (let column = merge.s.c; column <= merge.e.c; column += 1) {
                const reference = XLSX.utils.encode_cell({ r: row, c: column });
                if (!materialized[reference]) materialized[reference] = { ...anchor };
            }
        }
    }
    return materialized;
}

function normalizeCellValue(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

function readWorkbookSheets(workbook = {}) {
    const sheetNames = Array.isArray(workbook.SheetNames) ? workbook.SheetNames : [];
    if (!sheetNames.length) throw new Error('工作簿中没有可读取的工作表。');
    if (sheetNames.length > ROSTER_FILE_LIMITS.maxSheets) {
        throw new Error(`任课工作簿不能超过 ${ROSTER_FILE_LIMITS.maxSheets} 个工作表。`);
    }

    let totalNonEmptyCells = 0;
    return sheetNames.map((name, index) => {
        const sheet = workbook.Sheets?.[name] || {};
        const range = rangeForSheet(sheet);
        if (range && range.e.r + 1 > ROSTER_FILE_LIMITS.maxRowsPerSheet) {
            throw new Error(`工作表“${name}”不能超过 ${ROSTER_FILE_LIMITS.maxRowsPerSheet} 行。`);
        }
        if (range && range.e.c + 1 > ROSTER_FILE_LIMITS.maxColumnsPerSheet) {
            throw new Error(`工作表“${name}”不能超过 ${ROSTER_FILE_LIMITS.maxColumnsPerSheet} 列。`);
        }

        const materialized = materializeMergedCells(sheet);
        const matrix = XLSX.utils.sheet_to_json(materialized, {
            header: 1,
            defval: '',
            raw: false,
            blankrows: true,
            dateNF: 'yyyy-mm-dd',
        });
        const rows = [];
        matrix.forEach((rawCells, rowIndex) => {
            const cells = (Array.isArray(rawCells) ? rawCells : [])
                .slice(0, ROSTER_FILE_LIMITS.maxColumnsPerSheet)
                .map(normalizeCellValue);
            const nonEmpty = cells.filter(Boolean).length;
            if (!nonEmpty) return;
            totalNonEmptyCells += nonEmpty;
            if (totalNonEmptyCells > ROSTER_FILE_LIMITS.maxNonEmptyCells) {
                throw new Error(`任课工作簿非空单元格不能超过 ${ROSTER_FILE_LIMITS.maxNonEmptyCells} 个。`);
            }
            rows.push({ sourceRow: rowIndex + 1, cells });
        });

        const workbookSheet = workbook.Workbook?.Sheets?.[index] || {};
        return {
            id: `sheet-${index + 1}`,
            name,
            index,
            hidden: Number(workbookSheet.Hidden || 0) > 0,
            rows,
            rowCount: rows.length,
        };
    });
}

export function readRosterFileSource({ buffer, filename = '' } = {}) {
    const detected = detectRosterFileFormat(buffer, filename);
    if (detected.format === 'txt') {
        return {
            kind: 'text',
            format: detected.format,
            filename,
            warnings: detected.warnings,
            text: decodeTextBuffer(buffer),
            sheets: [],
        };
    }

    let workbook;
    try {
        const isCsv = detected.format === 'csv';
        workbook = XLSX.read(isCsv ? decodeTextBuffer(buffer) : buffer, {
            type: isCsv ? 'string' : 'buffer',
            cellDates: false,
            cellFormula: true,
            cellNF: false,
            cellStyles: false,
            bookVBA: false,
            sheetRows: ROSTER_FILE_LIMITS.maxRowsPerSheet + 1,
            WTF: false,
        });
    } catch (error) {
        throw workbookReadError(error, detected.format);
    }

    return {
        kind: 'workbook',
        format: detected.format,
        filename,
        warnings: detected.warnings,
        text: '',
        sheets: readWorkbookSheets(workbook),
    };
}
