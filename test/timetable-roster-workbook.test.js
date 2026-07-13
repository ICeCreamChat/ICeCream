import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as XLSX from '@e965/xlsx';

import { createGatewayApp } from '../gateway/app.js';
import {
    parseRosterAiOrLocal,
    parseTimetableRosterFile,
    previewTimetableRosterFile,
} from '../gateway/services/timetable-import.js';
import {
    detectRosterFileFormat,
    readRosterFileSource,
} from '../gateway/services/timetable-roster-workbook.js';

const HEADERS = ['年级', '班级', '课程', '教师', '周课时', '连堂', '教室', '课程类型', '课程标签'];

function workbookBuffer(sheetDefinitions, { bookType = 'xlsx' } = {}) {
    const workbook = XLSX.utils.book_new();
    sheetDefinitions.forEach(definition => {
        const sheet = XLSX.utils.aoa_to_sheet(definition.rows || []);
        if (definition.merges) sheet['!merges'] = definition.merges;
        XLSX.utils.book_append_sheet(workbook, sheet, definition.name);
    });
    if (sheetDefinitions.some(definition => definition.hidden)) {
        workbook.Workbook = {
            Sheets: sheetDefinitions.map(definition => ({ Hidden: definition.hidden ? 1 : 0 })),
        };
    }
    return XLSX.write(workbook, { type: 'buffer', bookType });
}

function aiResponse(payload) {
    return {
        ok: true,
        async json() {
            return { choices: [{ message: { content: JSON.stringify(payload) } }] };
        },
    };
}

function naturalRosterText(rows = []) {
    const categoryLabel = {
        main: '主科',
        lab: '实验课程',
        quality: '活动/场地课程',
        normal: '普通课程',
    };
    const blockLabel = {
        single: '不要求连堂，按单节课安排',
        double: '要求双连堂安排',
        mixed: '可单节或连堂灵活安排',
    };
    return rows.map(row => [
        `${row.grade}${row.className}的${row.subjectName}由${row.teacherName}老师任教`,
        `每周安排${row.weeklyHours}课时`,
        blockLabel[row.blockPreference] || blockLabel.single,
        row.roomName ? `上课地点为${row.roomName.replace(/、/g, '或')}` : '',
        `课程类型为${categoryLabel[row.subjectCategory] || '普通课程'}`,
        row.subjectTags?.length ? `课程标签为${row.subjectTags.join('、')}` : '',
    ].filter(Boolean).join('，') + '。').join('\n');
}

test('real school roster workbook keeps exact provenance and deterministic baseline', async () => {
    const file = {
        filename: '真实学校整学期任课数据.xlsx',
        buffer: fs.readFileSync('真实学校整学期任课数据.xlsx'),
    };
    let aiCalls = 0;
    const preview = await parseRosterAiOrLocal({
        file,
        project: {},
        env: { DEEPSEEK_API_KEY: 'configured-but-unused' },
        fetchImpl: async () => {
            aiCalls += 1;
            throw new Error('standard workbook must not call AI');
        },
    });

    assert.equal(aiCalls, 0);
    assert.equal(preview.source, 'local');
    assert.deepEqual(preview.parseSummary, {
        format: 'xlsx',
        sheetCount: 1,
        includedSheetCount: 1,
        includedSheetNames: ['任课数据'],
        localRowCount: 360,
        aiRowCount: 0,
        unresolvedRowCount: 0,
        aiAttempted: false,
        aiCallCount: 0,
    });
    assert.deepEqual(preview.stats, {
        classCount: 30,
        teacherCount: 62,
        subjectCount: 14,
        planCount: 360,
        totalLessons: 900,
        blockLessons: 160,
        fixedRoomCount: 43,
        issueCount: 0,
    });
    assert.deepEqual(preview.importReport.summary, { total: 360, kept: 360, degraded: 0, dropped: 0, review: 0 });
    assert.deepEqual(
        [preview.draftRows[0], preview.draftRows[179], preview.draftRows[359]].map(row => [
            row.sourceSheet,
            Number(row.sourceRow),
            row.className,
            row.subjectName,
            row.teacherName,
            Number(row.weeklyHours),
            row.blockPreference,
            row.roomName,
        ]),
        [
            ['任课数据', 2, 'G7-1班', '语文', '刘书涵', 5, 'single', 'G7-01本班教室'],
            ['任课数据', 181, 'G8-5班', '物理', '余思齐', 2, 'mixed', '物理实验室A、物理实验室B'],
            ['任课数据', 361, 'G9-10班', '劳动', '顾安然', 1, 'single', '劳动实践室'],
        ],
    );

    const imported = parseTimetableRosterFile(file);
    assert.equal(imported.lessonPlans.length, 360);
    assert.equal(imported.rooms.length, 43);
    assert.equal(imported.lessonPlans.filter(plan => plan.activityTypes.includes('实验课')).length, 50);
    assert.equal(imported.lessonPlans.filter(plan => plan.requiredResourceTypes.includes('实验室')).length, 50);
    assert.equal(imported.lessonPlans.filter(plan => plan.requiredResourceTypes.includes('计算机教室')).length, 30);
    assert.equal(imported.lessonPlans[179].allowedRoomIds.length, 2);
});

test('real school roster natural-language text matches the workbook baseline without AI', async () => {
    const file = {
        filename: '真实学校整学期任课数据.xlsx',
        buffer: fs.readFileSync('真实学校整学期任课数据.xlsx'),
    };
    const workbookPreview = previewTimetableRosterFile(file);
    const text = naturalRosterText(workbookPreview.draftRows);
    let aiCalls = 0;
    const preview = await parseRosterAiOrLocal({
        text,
        project: {},
        env: { DEEPSEEK_API_KEY: 'configured-but-unused' },
        fetchImpl: async () => {
            aiCalls += 1;
            throw new Error('high-confidence natural roster text must not call AI');
        },
    });

    assert.equal(aiCalls, 0);
    assert.equal(preview.source, 'local');
    assert.deepEqual(preview.parseSummary, {
        format: 'text',
        sheetCount: 0,
        includedSheetCount: 0,
        includedSheetNames: [],
        localRowCount: 360,
        aiRowCount: 0,
        unresolvedRowCount: 0,
        aiAttempted: false,
        aiCallCount: 0,
    });
    assert.deepEqual(preview.stats, {
        classCount: 30,
        teacherCount: 62,
        subjectCount: 14,
        planCount: 360,
        totalLessons: 900,
        blockLessons: 160,
        fixedRoomCount: 43,
        issueCount: 0,
    });
    assert.deepEqual(preview.importReport.summary, { total: 360, kept: 360, degraded: 0, dropped: 0, review: 0 });
    assert.deepEqual(
        [preview.draftRows[0], preview.draftRows[179], preview.draftRows[359]].map(row => [
            Number(row.sourceRow), row.grade, row.className, row.subjectName, row.teacherName,
            Number(row.weeklyHours), row.blockPreference, row.roomName,
        ]),
        [
            [1, '七年级', 'G7-1班', '语文', '刘书涵', 5, 'single', 'G7-01本班教室'],
            [180, '八年级', 'G8-5班', '物理', '余思齐', 2, 'mixed', '物理实验室A、物理实验室B'],
            [360, '九年级', 'G9-10班', '劳动', '顾安然', 1, 'single', '劳动实践室'],
        ],
    );
    assert.equal(preview.draftRows.filter(row => row.activityTypes.includes('实验课')).length, 50);
    assert.equal(preview.draftRows.filter(row => row.requiredResourceTypes.includes('实验室')).length, 50);
    assert.equal(preview.draftRows.filter(row => row.requiredResourceTypes.includes('计算机教室')).length, 30);
});

test('long unrecognized roster text is sent to AI in bounded line batches without truncation', async () => {
    const text = Array.from({ length: 91 }, (_, index) => `自定义任课记录${index + 1}，等待智能识别。`).join('\n');
    let calls = 0;
    const preview = await parseRosterAiOrLocal({
        text,
        project: {},
        env: { DEEPSEEK_API_KEY: 'test-key' },
        fetchImpl: async (_url, options) => {
            calls += 1;
            const body = JSON.parse(options.body);
            const userMessage = body.messages[1].content;
            assert.equal(userMessage.length <= 10_000, true);
            assert.equal(body.max_tokens, 8192);
            const sourceRows = [...userMessage.matchAll(/\[第(\d+)行\]/g)].map(match => Number(match[1]));
            return aiResponse({
                draftRows: sourceRows.map(sourceRow => ({
                    sourceRow,
                    grade: '七年级',
                    className: `${sourceRow}班`,
                    subjectName: '校本课程',
                    teacherName: `教师${sourceRow}`,
                    weeklyHours: 2,
                    blockPreference: 'single',
                })),
            });
        },
    });

    assert.equal(calls, 3);
    assert.equal(preview.source, 'ai');
    assert.equal(preview.draftRows.length, 91);
    assert.equal(preview.parseSummary.aiAttempted, true);
    assert.equal(preview.parseSummary.aiCallCount, 3);
    assert.equal(preview.parseSummary.unresolvedRowCount, 0);
    assert.deepEqual(preview.draftRows.map(row => Number(row.sourceRow)), Array.from({ length: 91 }, (_, index) => index + 1));
});

test('reader parses genuine BIFF8 XLS and quoted CSV through the same workbook model', () => {
    const xls = workbookBuffer([{ name: '任课', rows: [HEADERS, ['七年级', '1班', '语文', '林老师', 5, 'single', 'A101', 'main', '主科']] }], { bookType: 'biff8' });
    const xlsPreview = previewTimetableRosterFile({ filename: '任课.xls', buffer: xls });
    assert.equal(detectRosterFileFormat(xls, '任课.xls').format, 'xls');
    assert.equal(xlsPreview.parseSummary.format, 'xls');
    assert.equal(xlsPreview.draftRows[0].sourceSheet, '任课');
    assert.equal(xlsPreview.draftRows[0].teacherName, '林老师');

    const csv = Buffer.from('年级,班级,课程,教师,周课时,教室\n七年级,1班,语文,"林老师,王老师",5,A101\n');
    const csvPreview = previewTimetableRosterFile({ filename: '任课.csv', buffer: csv });
    assert.equal(csvPreview.parseSummary.format, 'csv');
    assert.equal(csvPreview.draftRows[0].teacherName, '林老师、王老师');
});

test('multi-sheet reader finds offset merged headers and reports ignored sheets', () => {
    const buffer = workbookBuffer([
        { name: '说明', rows: [['本文件由教务处导出']] },
        {
            name: '七年级任课',
            rows: [['七年级任课总表'], [], HEADERS, ['七年级', '1班', '数学', '周老师', 4, 'double', 'A102', 'main', '主科']],
            merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } }],
        },
        { name: '隐藏任课', hidden: true, rows: [HEADERS, ['八年级', '2班', '英语', '吴老师', 4, 'single', 'B201', 'main', '主科']] },
        { name: '八年级任课', rows: [HEADERS, ['八年级', '3班', '物理', '余老师', 2, 'mixed', '物理实验室', 'lab', '实验']] },
    ]);
    const preview = previewTimetableRosterFile({ filename: '多表.xlsx', buffer });

    assert.equal(preview.draftRows.length, 2);
    assert.deepEqual(preview.draftRows.map(row => [row.sourceSheet, Number(row.sourceRow)]), [
        ['七年级任课', 4],
        ['八年级任课', 2],
    ]);
    assert.deepEqual(preview.sheetReviews.map(sheet => [sheet.name, sheet.selected, sheet.status]), [
        ['说明', false, 'ignored'],
        ['七年级任课', true, 'included'],
        ['隐藏任课', false, 'ignored'],
        ['八年级任课', true, 'included'],
    ]);
});

test('content sniffing parses workbook extension mismatch and rejects corrupt or excessive files', () => {
    const xlsx = workbookBuffer([{ name: '任课', rows: [HEADERS, ['七年级', '1班', '语文', '林老师', 5]] }]);
    const mismatched = previewTimetableRosterFile({ filename: '错误扩展.xls', buffer: xlsx });
    assert.equal(mismatched.parseSummary.format, 'xlsx');
    assert.match(mismatched.warnings.join(' '), /实际内容为 XLSX/);
    assert.throws(
        () => readRosterFileSource({ filename: '损坏.xlsx', buffer: Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00]) }),
        /无法读取 XLSX/,
    );
    assert.throws(
        () => readRosterFileSource({ filename: '任课.pdf', buffer: Buffer.from('%PDF-1.7') }),
        /仅支持/,
    );

    const tooManySheets = workbookBuffer(Array.from({ length: 21 }, (_, index) => ({ name: `S${index + 1}`, rows: [['x']] })));
    assert.throws(
        () => readRosterFileSource({ filename: '过多工作表.xlsx', buffer: tooManySheets }),
        /不能超过 20 个工作表/,
    );

    const tooManyColumns = workbookBuffer([{ name: '宽表', rows: [Array.from({ length: 101 }, (_, index) => `C${index + 1}`)] }]);
    assert.throws(
        () => readRosterFileSource({ filename: '过宽.xlsx', buffer: tooManyColumns }),
        /不能超过 100 列/,
    );

    const tooManyRows = workbookBuffer([{
        name: '长表',
        rows: Array.from({ length: 10_001 }, (_, index) => [`R${index + 1}`]),
    }]);
    assert.throws(
        () => readRosterFileSource({ filename: '过长.xlsx', buffer: tooManyRows }),
        /不能超过 10000 行/,
    );

    const tooManyCells = workbookBuffer([{
        name: '密集表',
        rows: Array.from({ length: 1_001 }, (_, row) => Array.from({ length: 100 }, (_, column) => `${row}-${column}`)),
    }]);
    assert.throws(
        () => readRosterFileSource({ filename: '过密.xlsx', buffer: tooManyCells }),
        /非空单元格不能超过 100000 个/,
    );
});

test('formula cached values and merged identity cells are read without evaluating formulas', () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
        HEADERS,
        ['七年级', '1班', '数学', '周老师', null, 'single', 'A102', 'main', '主科'],
        [null, '2班', '数学', '吴老师', 4, 'single', 'A103', 'main', '主科'],
    ]);
    sheet.E2 = { t: 'n', f: '2+3', v: 5 };
    sheet['!merges'] = [{ s: { r: 1, c: 0 }, e: { r: 2, c: 0 } }];
    XLSX.utils.book_append_sheet(workbook, sheet, '任课');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const preview = previewTimetableRosterFile({ filename: '公式与合并.xlsx', buffer });
    assert.deepEqual(preview.draftRows.map(row => [row.grade, Number(row.weeklyHours)]), [['七年级', 5], ['七年级', 4]]);
});

test('AI maps only an unresolved header and produces a mixed provenance result', async () => {
    const buffer = workbookBuffer([
        { name: '标准表', rows: [HEADERS, ['七年级', '1班', '语文', '林老师', 5, 'single', 'A101', 'main', '主科']] },
        { name: 'Custom', rows: [['Level', 'Cohort', 'Lesson', 'Instructor', 'Units'], ['G8', '2班', 'Math', 'Wang', 4]] },
    ]);
    let calls = 0;
    const preview = await parseRosterAiOrLocal({
        file: { filename: '混合.xlsx', buffer },
        project: {},
        env: { DEEPSEEK_API_KEY: 'test-key' },
        fetchImpl: async (_url, options) => {
            calls += 1;
            const body = JSON.parse(options.body);
            assert.match(body.messages[0].content, /列含义/);
            return aiResponse({
                headerRow: 1,
                columnMappings: [
                    { columnIndex: 0, field: 'grade' },
                    { columnIndex: 1, field: 'className' },
                    { columnIndex: 2, field: 'subjectName' },
                    { columnIndex: 3, field: 'teacherName' },
                    { columnIndex: 4, field: 'weeklyHours' },
                ],
                confidence: 0.98,
            });
        },
    });
    assert.equal(calls, 1);
    assert.equal(preview.source, 'mixed');
    assert.deepEqual(preview.draftRows.map(row => row.parseSource), ['local', 'ai']);
    assert.deepEqual(preview.parseSummary, {
        format: 'xlsx',
        sheetCount: 2,
        includedSheetCount: 2,
        includedSheetNames: ['标准表', 'Custom'],
        localRowCount: 1,
        aiRowCount: 1,
        unresolvedRowCount: 0,
        aiAttempted: true,
        aiCallCount: 1,
    });
});

test('AI row supplement preserves known local fields and uses stable source keys', async () => {
    const headers = [...HEADERS, '备注'];
    const buffer = workbookBuffer([{ name: '任课', rows: [headers, ['七年级', '1班', '语文', '', 5, 'single', 'A101', 'main', '主科', '教师为林老师']] }]);
    const preview = await parseRosterAiOrLocal({
        file: { filename: '缺教师.xlsx', buffer },
        project: {},
        env: { DEEPSEEK_API_KEY: 'test-key' },
        fetchImpl: async (_url, options) => {
            const body = JSON.parse(options.body);
            const user = JSON.parse(body.messages[1].content);
            assert.equal(user.rows[0].sourceKey, 'sheet-1:2');
            return aiResponse({ draftRows: [{ sourceKey: 'sheet-1:2', className: '错误班级', subjectName: '错误课程', teacherName: '林老师' }] });
        },
    });
    assert.equal(preview.source, 'ai');
    assert.equal(preview.draftRows[0].className, '1班');
    assert.equal(preview.draftRows[0].subjectName, '语文');
    assert.equal(preview.draftRows[0].teacherName, '林老师');
    assert.equal(preview.draftRows[0].sourceRow, 2);
    assert.match(preview.draftRows[0].issues.map(issue => issue.message).join(' '), /AI 补充与本地字段冲突/);
    assert.equal(preview.importReport.summary.review > 0, true);
});

test('unconfigured AI keeps local data and reports unresolved sheets without silent success', async () => {
    const buffer = workbookBuffer([{ name: 'Custom', rows: [['Level', 'Cohort', 'Lesson', 'Instructor'], ['G8', '2班', 'Math', 'Wang']] }]);
    const preview = await parseRosterAiOrLocal({ file: { filename: '未知.xlsx', buffer }, project: {}, env: {} });
    assert.equal(preview.source, 'local');
    assert.equal(preview.draftRows.length, 0);
    assert.equal(preview.parseSummary.aiAttempted, true);
    assert.equal(preview.parseSummary.aiCallCount, 0);
    assert.equal(preview.parseSummary.unresolvedRowCount, 2);
    assert.equal(preview.importReport.summary.review > 0, true);
    assert.match(preview.warnings.join(' '), /未自动导入|AI 补充解析未完成/);
});

test('AI supplement enforces the eight-call workbook budget without dropping sheet reports', async () => {
    const sheets = Array.from({ length: 9 }, (_, index) => ({
        name: `Custom${index + 1}`,
        rows: [['Level', 'Cohort', 'Lesson', 'Instructor'], ['G8', `${index + 1}班`, 'Math', 'Wang']],
    }));
    let calls = 0;
    const preview = await parseRosterAiOrLocal({
        file: { filename: '九个未知表.xlsx', buffer: workbookBuffer(sheets) },
        project: {},
        env: { DEEPSEEK_API_KEY: 'test-key' },
        fetchImpl: async () => {
            calls += 1;
            return aiResponse({ columnMappings: [] });
        },
    });
    assert.equal(calls, 8);
    assert.equal(preview.parseSummary.aiCallCount, 8);
    assert.equal(preview.parseSummary.unresolvedRowCount, 18);
    assert.equal(preview.sheetReviews.length, 9);
    assert.equal(preview.sheetReviews.every(sheet => sheet.status === 'review' && !sheet.selected), true);
    assert.equal(preview.importReport.summary.review >= 9, true);
});

test('roster preview and confirm APIs preserve the real workbook baseline in an isolated store', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    const previousDeepSeekKey = process.env.DEEPSEEK_API_KEY;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'icecream-roster-api-'));
    process.env.TIMETABLE_DATA_DIR = dataDir;
    process.env.DEEPSEEK_API_KEY = '';
    process.env.OPENAI_API_KEY = '';
    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
    });

    try {
        const form = new FormData();
        form.append('file', new Blob([fs.readFileSync('真实学校整学期任课数据.xlsx')], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }), '真实学校整学期任课数据.xlsx');
        const previewResponse = await fetch(`${baseUrl}/api/tools/timetable/roster/preview`, { method: 'POST', body: form });
        const previewPayload = await previewResponse.json();
        assert.equal(previewResponse.status, 200);
        assert.equal(previewPayload.success, true);
        assert.equal(previewPayload.data.source, 'local');
        assert.equal(previewPayload.data.parseSummary.aiCallCount, 0);
        assert.equal(previewPayload.data.sheetReviews[0].name, '任课数据');
        assert.equal(previewPayload.data.draftRows.length, 360);

        const importResponse = await fetch(`${baseUrl}/api/tools/timetable/roster/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: previewPayload.data.draftRows }),
        });
        const importPayload = await importResponse.json();
        assert.equal(importResponse.status, 200);
        assert.equal(importPayload.success, true);
        assert.equal(importPayload.data.import.count, 360);
        assert.equal(importPayload.data.project.lessonPlans.length, 360);
        assert.equal(importPayload.data.project.rooms.length, 43);
        assert.equal(importPayload.data.project.lessonPlans.filter(plan => plan.activityTypes.includes('实验课')).length, 50);
        assert.equal(importPayload.data.project.lessonPlans.filter(plan => plan.requiredResourceTypes.includes('计算机教室')).length, 30);
    } finally {
        await new Promise(resolve => server.close(resolve));
        await rm(dataDir, { recursive: true, force: true });
        if (previousDataDir === undefined) delete process.env.TIMETABLE_DATA_DIR;
        else process.env.TIMETABLE_DATA_DIR = previousDataDir;
        if (previousDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
        else process.env.DEEPSEEK_API_KEY = previousDeepSeekKey;
        if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
});
