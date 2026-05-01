import assert from 'node:assert/strict';
import test from 'node:test';

import AdmZip from 'adm-zip';

import {
  parseRosterFile,
  parseStudentsText,
} from '../gateway/services/seating-roster.js';

function createMinimalXlsx(rows) {
  const esc = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const colName = index => String.fromCharCode('A'.charCodeAt(0) + index);
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, colIndex) => `
      <c r="${colName(colIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${esc(value)}</t></is></c>
    `).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');

  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
    </Types>`));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`));
  zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="名单" sheetId="1" r:id="rId1"/></sheets>
    </workbook>`));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
    </Relationships>`));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>${sheetRows}</sheetData>
    </worksheet>`));
  return zip.toBuffer();
}

test('parseStudentsText handles pasted tabular roster data', () => {
  const result = parseStudentsText('张三\t男\t93\t142\n李四\t女\t88\t151\n王五 M 78 160');

  assert.equal(result.count, 3);
  assert.deepEqual(result.students, [
    { id: 's01', name: '张三', gender: 'M', grade: 93, height: 142 },
    { id: 's02', name: '李四', gender: 'F', grade: 88, height: 151 },
    { id: 's03', name: '王五', gender: 'M', grade: 78, height: 160 },
  ]);
});

test('parseStudentsText handles OCR markdown roster tables with sequence columns', () => {
  const text = `
| 序号 | 姓名 | 性别 | 身高 | 成绩 |
| --- | --- | --- | --- | --- |
| 1 | 米寒琳 | 女 | 111cm | 62 |
| 2 | 南门橙 | 男 | 177 | 91 |
`;
  const result = parseStudentsText(text);

  assert.equal(result.count, 2);
  assert.deepEqual(result.students, [
    { id: 's01', name: '米寒琳', gender: 'F', grade: 62, height: 111 },
    { id: 's02', name: '南门橙', gender: 'M', grade: 91, height: 177 },
  ]);
});

test('parseStudentsText handles OCR text rows without treating sequence as names', () => {
  const result = parseStudentsText('1 米寒琳 女 111 62\n2 南门橙 男 177 91');

  assert.equal(result.count, 2);
  assert.deepEqual(result.students, [
    { id: 's01', name: '米寒琳', gender: 'F', grade: 62, height: 111 },
    { id: 's02', name: '南门橙', gender: 'M', grade: 91, height: 177 },
  ]);
});

test('parseRosterFile parses text files through the shared student parser', async () => {
  const result = await parseRosterFile({
    buffer: Buffer.from('张三,男,93,142\n李四,女,88,151', 'utf8'),
    originalname: 'students.csv',
    mimetype: 'text/csv',
  });

  assert.equal(result.count, 2);
  assert.equal(result.source, 'text');
  assert.equal(result.students[0].name, '张三');
  assert.equal(result.students[1].gender, 'F');
});

test('parseRosterFile parses a real xlsx workbook', async () => {
  const buffer = createMinimalXlsx([
    ['姓名', '性别', '成绩', '身高'],
    ['张三', '男', '93', '142'],
    ['李四', '女', '88', '151'],
  ]);

  const result = await parseRosterFile({
    buffer,
    originalname: 'students.xlsx',
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  assert.equal(result.count, 2);
  assert.equal(result.source, 'xlsx');
  assert.deepEqual(result.students, [
    { id: 's01', name: '张三', gender: 'M', grade: 93, height: 142 },
    { id: 's02', name: '李四', gender: 'F', grade: 88, height: 151 },
  ]);
});

test('parseRosterFile rejects unsupported roster uploads', async () => {
  await assert.rejects(
    parseRosterFile({
      buffer: Buffer.from('nope'),
      originalname: 'students.exe',
      mimetype: 'application/octet-stream',
    }),
    /不支持/
  );
});
