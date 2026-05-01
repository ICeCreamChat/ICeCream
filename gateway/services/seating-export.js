import AdmZip from 'adm-zip';

export const SEATING_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const MAX_EXPORT_ROWS = 300;
const MAX_EXPORT_COLS = 80;
const MAX_EXPORT_STUDENTS = 1200;

function intInRange(value, fallback, min, max) {
    const num = Number.parseInt(value, 10);
    if (!Number.isInteger(num)) return fallback;
    return Math.max(min, Math.min(max, num));
}

function cleanText(value, max = 80) {
    return String(value ?? '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function xml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function columnName(index) {
    let n = index + 1;
    let name = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        name = String.fromCharCode(65 + rem) + name;
        n = Math.floor((n - 1) / 26);
    }
    return name;
}

function cellRef(row, col) {
    return `${columnName(col)}${row}`;
}

function normalizeCells(rawCells, rows, cols) {
    return Array.from({ length: rows }, (_, r) => {
        const source = Array.isArray(rawCells?.[r]) ? rawCells[r] : [];
        return Array.from({ length: cols }, (_, c) => (
            source[c] === 'aisle' || source[c] === 'empty' ? 'aisle' : 'seat'
        ));
    });
}

function normalizeLayout(rawLayout, rows, cols) {
    return Array.from({ length: rows }, (_, r) => {
        const source = Array.isArray(rawLayout?.[r]) ? rawLayout[r] : [];
        return Array.from({ length: cols }, (_, c) => {
            const value = source[c];
            return typeof value === 'string' && value.length <= 120 ? value : null;
        });
    });
}

function normalizeLocalAisleList(items = [], orientation, rows, cols) {
    const maxRow = orientation === 'vertical' ? rows - 1 : rows - 2;
    const maxCol = orientation === 'vertical' ? cols - 2 : cols - 1;
    const seen = new Set();
    const result = [];
    for (const item of Array.isArray(items) ? items : []) {
        const row = Number.parseInt(item?.row, 10);
        const col = Number.parseInt(item?.col, 10);
        if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
        if (row < 0 || col < 0 || row > maxRow || col > maxCol) continue;
        const key = `${row},${col}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ row, col });
    }
    return result.sort((a, b) => a.row - b.row || a.col - b.col);
}

function normalizeLocalAisles(rawLocalAisles = {}, rows, cols) {
    return {
        vertical: normalizeLocalAisleList(rawLocalAisles.vertical, 'vertical', rows, cols),
        horizontal: normalizeLocalAisleList(rawLocalAisles.horizontal, 'horizontal', rows, cols),
    };
}

function hasLocalAisle(localAisles = {}, orientation, row, col) {
    const list = orientation === 'horizontal' ? localAisles.horizontal : localAisles.vertical;
    return Array.isArray(list) && list.some(item => item.row === row && item.col === col);
}

function seatTouchesLocalAisle(localAisles = {}, row, col) {
    return hasLocalAisle(localAisles, 'vertical', row, col)
        || hasLocalAisle(localAisles, 'vertical', row, col - 1)
        || hasLocalAisle(localAisles, 'horizontal', row, col)
        || hasLocalAisle(localAisles, 'horizontal', row - 1, col);
}

function normalizeStudents(rawStudents = []) {
    if (!Array.isArray(rawStudents)) return [];
    return rawStudents.slice(0, MAX_EXPORT_STUDENTS).map(student => ({
        id: cleanText(student?.id, 80),
        name: cleanText(student?.name, 60),
        gender: student?.gender === 'M' || student?.gender === 'F' ? student.gender : '',
        grade: cleanText(student?.grade, 20),
        height: cleanText(student?.height, 20),
    })).filter(student => student.id && student.name);
}

export function normalizeSeatingExportRequest(body = {}) {
    const requestedRows = Number.parseInt(body.rows, 10);
    const requestedCols = Number.parseInt(body.cols, 10);
    if (!Number.isInteger(requestedRows) || requestedRows < 1 || requestedRows > MAX_EXPORT_ROWS) {
        throw new Error(`座位表行数必须在 1-${MAX_EXPORT_ROWS} 之间`);
    }
    if (!Number.isInteger(requestedCols) || requestedCols < 1 || requestedCols > MAX_EXPORT_COLS) {
        throw new Error(`座位表列数必须在 1-${MAX_EXPORT_COLS} 之间`);
    }

    const rows = intInRange(body.classroomLayout?.rows, requestedRows, 1, MAX_EXPORT_ROWS);
    const cols = intInRange(body.classroomLayout?.cols, requestedCols, 1, MAX_EXPORT_COLS);
    const guardians = Array.isArray(body.guardians)
        ? [cleanText(body.guardians[0], 80) || null, cleanText(body.guardians[1], 80) || null]
        : [null, null];

    return {
        rows,
        cols,
        layout: normalizeLayout(body.layout, rows, cols),
        classroomLayout: {
            rows,
            cols,
            cells: normalizeCells(body.classroomLayout?.cells, rows, cols),
            localAisles: normalizeLocalAisles(body.localAisles || body.classroomLayout?.localAisles, rows, cols),
            guardians: {
                enabled: Boolean(body.classroomLayout?.guardians?.enabled || guardians.some(Boolean)),
                left: cleanText(body.classroomLayout?.guardians?.left, 80) || guardians[0],
                right: cleanText(body.classroomLayout?.guardians?.right, 80) || guardians[1],
            },
        },
        localAisles: normalizeLocalAisles(body.localAisles || body.classroomLayout?.localAisles, rows, cols),
        guardians,
        students: normalizeStudents(body.students),
    };
}

function createSharedStringTable() {
    const map = new Map();
    const values = [];
    return {
        index(value) {
            const text = String(value ?? '');
            if (!map.has(text)) {
                map.set(text, values.length);
                values.push(text);
            }
            return map.get(text);
        },
        xml() {
            const items = values
                .map(value => `<si><t xml:space="preserve">${xml(value)}</t></si>`)
                .join('');
            return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${values.length}" uniqueCount="${values.length}">${items}</sst>`;
        },
    };
}

function stylesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4">
    <font><sz val="11"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="12"/><color rgb="FF3F2A1D"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="11"/><color rgb="FF334155"/><name val="Microsoft YaHei"/></font>
  </fonts>
  <fills count="8">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF173F2A"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF6B4638"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE7D4B8"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDCEBFF"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFE0EF"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFC9B896"/></left><right style="thin"><color rgb="FFC9B896"/></right><top style="thin"><color rgb="FFC9B896"/></top><bottom style="thin"><color rgb="FFC9B896"/></bottom><diagonal/></border>
    <border><left style="dashed"><color rgb="FF94A3B8"/></left><right style="dashed"><color rgb="FF94A3B8"/></right><top style="dashed"><color rgb="FF94A3B8"/></top><bottom style="dashed"><color rgb="FF94A3B8"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="11">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFill="1" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="7" borderId="2" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="5" borderId="2" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="6" borderId="2" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="4" borderId="2" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function studentText(student, fallback = '') {
    if (!student) return fallback;
    return student.name;
}

function buildWorksheetXml(snapshot, sharedStrings) {
    const studentMap = new Map(snapshot.students.map(student => [student.id, student]));
    const rows = [];
    const merges = [];
    const cols = Math.max(1, snapshot.cols);
    const lastCol = columnName(cols - 1);
    const centerCol = Math.floor((cols - 1) / 2);

    const makeCell = (rowNumber, colIndex, value, styleId = 0) => {
        const ref = cellRef(rowNumber, colIndex);
        if (value === undefined || value === null || value === '') return `<c r="${ref}" s="${styleId}"/>`;
        return `<c r="${ref}" s="${styleId}" t="s"><v>${sharedStrings.index(value)}</v></c>`;
    };
    const makeRow = (rowNumber, cells, height) => {
        const rowCells = Array.from({ length: cols }, (_, col) => {
            const cell = cells[col] || {};
            return makeCell(rowNumber, col, cell.value, cell.style ?? 0);
        }).join('');
        return `<row r="${rowNumber}" ht="${height}" customHeight="1">${rowCells}</row>`;
    };

    rows.push(makeRow(1, [{ value: '黑板', style: 1 }], 34));
    if (cols > 1) merges.push(`<mergeCell ref="A1:${lastCol}1"/>`);

    const guardianRow = [];
    if (snapshot.classroomLayout.guardians.enabled) {
        guardianRow[0] = { value: studentText(studentMap.get(snapshot.guardians[0] || snapshot.classroomLayout.guardians.left), '左护法'), style: 7 };
        guardianRow[cols - 1] = { value: studentText(studentMap.get(snapshot.guardians[1] || snapshot.classroomLayout.guardians.right), '右护法'), style: 7 };
    }
    guardianRow[centerCol] = { value: '讲台', style: 2 };
    rows.push(makeRow(2, guardianRow, 54));
    rows.push(makeRow(3, [], 10));

    for (let r = 0; r < snapshot.rows; r++) {
        const rowNumber = r + 4;
        const cells = [];
        for (let c = 0; c < snapshot.cols; c++) {
            if (snapshot.classroomLayout.cells[r]?.[c] !== 'seat') {
                cells[c] = { value: '过道', style: 3 };
                continue;
            }
            const touchesLocalAisle = seatTouchesLocalAisle(snapshot.localAisles || snapshot.classroomLayout.localAisles, r, c);
            const student = studentMap.get(snapshot.layout[r]?.[c]);
            if (!student) {
                cells[c] = { value: '', style: touchesLocalAisle ? 10 : 6 };
                continue;
            }
            cells[c] = {
                value: studentText(student),
                style: touchesLocalAisle ? (student.gender === 'F' ? 9 : 8) : (student.gender === 'F' ? 5 : 4),
            };
        }
        rows.push(makeRow(rowNumber, cells, 58));
    }

    const colXml = Array.from({ length: cols }, (_, col) => (
        `<col min="${col + 1}" max="${col + 1}" width="16" customWidth="1"/>`
    )).join('');
    const mergeXml = merges.length ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>` : '';

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>
  <cols>${colXml}</cols>
  <sheetData>${rows.join('')}</sheetData>
  ${mergeXml}
</worksheet>`;
}

function workbookXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="座位图" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

export function buildSeatingExportXlsx(snapshot) {
    const sharedStrings = createSharedStringTable();
    const sheet = buildWorksheetXml(snapshot, sharedStrings);
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`));
    zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`));
    zip.addFile('xl/workbook.xml', Buffer.from(workbookXml()));
    zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`));
    zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(sheet));
    zip.addFile('xl/styles.xml', Buffer.from(stylesXml()));
    zip.addFile('xl/sharedStrings.xml', Buffer.from(sharedStrings.xml()));
    return zip.toBuffer();
}
