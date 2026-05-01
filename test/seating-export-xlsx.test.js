import AdmZip from 'adm-zip';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

async function withApp(run) {
  const server = createGatewayApp({ isDev: false }).listen(0, '127.0.0.1');
  const baseUrl = await new Promise(resolve => {
    server.on('listening', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  try {
    await run(baseUrl);
  } finally {
    await close(server);
  }
}

test('POST /api/tools/seating/export-xlsx returns a styled workbook', async () => {
  await withApp(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/tools/seating/export-xlsx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: 2,
        cols: 3,
        layout: [
          ['s01', null, 's02'],
          ['s03', null, null],
        ],
        classroomLayout: {
          rows: 2,
          cols: 3,
          cells: [
            ['seat', 'aisle', 'seat'],
            ['seat', 'aisle', 'seat'],
          ],
          guardians: { enabled: true, left: 's04', right: null },
        },
        guardians: ['s04', null],
        students: [
          { id: 's01', name: '张三', gender: 'M', grade: 'GRADE_SHOULD_NOT_EXPORT', height: 'HEIGHT_SHOULD_NOT_EXPORT' },
          { id: 's02', name: '李四', gender: 'F', grade: 88, height: 165 },
          { id: 's03', name: '王五', gender: 'M', grade: 70, height: 172 },
          { id: 's04', name: '赵六', gender: 'F', grade: 60, height: 160 },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /spreadsheetml\.sheet/);

    const buffer = Buffer.from(await response.arrayBuffer());
    const zip = new AdmZip(buffer);
    const entries = new Set(zip.getEntries().map(entry => entry.entryName));
    assert.equal(entries.has('xl/worksheets/sheet1.xml'), true);
    assert.equal(entries.has('xl/styles.xml'), true);

    const sheet = zip.readAsText('xl/worksheets/sheet1.xml');
    const sharedStrings = zip.readAsText('xl/sharedStrings.xml');
    assert.match(sheet, /mergeCells/);
    assert.match(sheet, /customHeight="1"/);
    assert.match(sharedStrings, /张三/);
    assert.match(sharedStrings, /讲台/);
    assert.match(sharedStrings, /过道/);
    assert.doesNotMatch(sharedStrings, /GRADE_SHOULD_NOT_EXPORT/);
    assert.doesNotMatch(sharedStrings, /HEIGHT_SHOULD_NOT_EXPORT/);
  });
});

test('POST /api/tools/seating/export-xlsx rejects invalid oversized input', async () => {
  await withApp(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/tools/seating/export-xlsx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: 301,
        cols: 2,
        layout: [],
        classroomLayout: { cells: [] },
        students: [],
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.success, false);
  });
});
