import assert from 'node:assert/strict';
import test from 'node:test';
import AdmZip from 'adm-zip';

import { createDefaultTimetableProject, runTimetableScheduler } from '../gateway/services/timetable-scheduler.js';
import { buildTimetableExportXlsx, TIMETABLE_XLSX_MIME } from '../gateway/services/timetable-export.js';

function sampleExportProject() {
    return createDefaultTimetableProject({
        schoolName: 'ICeCream 导出学校',
        term: '2026 春季',
        weekdays: 5,
        periodsPerDay: 4,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4],
        teachers: [
            { id: 't_math', name: '陈老师', subjects: ['math'], unavailableSlots: [] },
            { id: 't_cn', name: '林老师', subjects: ['chinese'], unavailableSlots: [] },
            { id: 't_pe', name: '周老师', subjects: ['pe'], unavailableSlots: [] },
        ],
        classes: [
            { id: 'c1', grade: '七年级', name: '1班' },
            { id: 'c2', grade: '七年级', name: '2班' },
        ],
        subjects: [
            { id: 'math', name: '数学', priority: 100, color: '#14b8a6' },
            { id: 'chinese', name: '语文', priority: 95, color: '#60a5fa' },
            { id: 'pe', name: '体育', priority: 35, color: '#f97316' },
        ],
        lessonPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3, blockPreference: 'single' },
            { id: 'lp2', classId: 'c1', subjectId: 'chinese', teacherId: 't_cn', weeklyHours: 3, blockPreference: 'single' },
            { id: 'lp3', classId: 'c2', subjectId: 'math', teacherId: 't_math', weeklyHours: 3, blockPreference: 'single' },
            { id: 'lp4', classId: 'c2', subjectId: 'pe', teacherId: 't_pe', weeklyHours: 2, blockPreference: 'double' },
        ],
        rules: { hardRules: {}, softRules: {} },
    });
}

function scheduledProject() {
    const project = sampleExportProject();
    const result = runTimetableScheduler(project);
    assert.equal(result.success, true, 'scheduler should produce a populated schedule');
    assert.ok(result.schedule.slots.length > 0, 'schedule should have placed slots');
    return { ...project, schedule: result.schedule };
}

function readWorkbook(buffer) {
    assert.ok(Buffer.isBuffer(buffer), 'export should return a Buffer');
    const zip = new AdmZip(buffer);
    const entries = new Map(zip.getEntries().map(entry => [entry.entryName.replace(/\\/g, '/'), entry]));

    assert.ok(entries.has('[Content_Types].xml'), 'workbook must contain [Content_Types].xml');

    const worksheetNames = [...entries.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
    assert.ok(worksheetNames.length >= 1, 'workbook must contain at least one worksheet xml');

    const text = name => zip.readAsText(entries.get(name));
    const sheetXml = worksheetNames.map(text).join('\n');
    const sharedStringsXml = entries.has('xl/sharedStrings.xml') ? text('xl/sharedStrings.xml') : '';
    const workbookXml = entries.has('xl/workbook.xml') ? text('xl/workbook.xml') : '';

    return { zip, sheetXml, sharedStringsXml, workbookXml, combined: `${sheetXml}\n${sharedStringsXml}` };
}

test('TIMETABLE_XLSX_MIME is the openxml spreadsheet mime type', () => {
    assert.equal(TIMETABLE_XLSX_MIME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('class timetable export produces a valid xlsx with class and lesson content', () => {
    const project = scheduledProject();
    const workbook = readWorkbook(buildTimetableExportXlsx(project, { type: 'class' }));

    assert.match(workbook.workbookXml, /班级课表/);
    // class owner labels combine grade + name
    assert.match(workbook.combined, /七年级1班/);
    assert.match(workbook.combined, /七年级2班/);
    // lesson labels include subject + teacher names
    assert.match(workbook.combined, /数学/);
    assert.match(workbook.combined, /陈老师/);
    // weekday / period header text
    assert.match(workbook.combined, /周一/);
});

test('class timetable export is the default when no type option is provided', () => {
    const project = scheduledProject();
    const workbook = readWorkbook(buildTimetableExportXlsx(project));

    assert.match(workbook.workbookXml, /班级课表/);
    assert.match(workbook.combined, /七年级1班/);
});

test('teacher timetable export produces a valid xlsx listing teacher names', () => {
    const project = scheduledProject();
    const workbook = readWorkbook(buildTimetableExportXlsx(project, { type: 'teacher' }));

    assert.match(workbook.workbookXml, /教师课表/);
    assert.match(workbook.combined, /陈老师/);
    assert.match(workbook.combined, /林老师/);
    assert.match(workbook.combined, /周老师/);
    // teacher mode labels carry the subject too
    assert.match(workbook.combined, /数学/);
});

test('master timetable export produces a single combined sheet', () => {
    const project = scheduledProject();
    const workbook = readWorkbook(buildTimetableExportXlsx(project, { type: 'master' }));

    assert.match(workbook.workbookXml, /总课表/);
    assert.match(workbook.combined, /总课表/);
    // master labels combine class, subject and teacher
    assert.match(workbook.combined, /七年级1班/);
    assert.match(workbook.combined, /数学/);
    assert.match(workbook.combined, /陈老师/);
});

test('published timetable export carries publication metadata and validation summary', () => {
    const project = scheduledProject();
    const publishedProject = {
        ...project,
        schedule: {
            ...project.schedule,
            publication: {
                ok: true,
                reason: 'ready',
                summary: {
                    totalLessons: project.schedule.score.totalLessons,
                    placedLessons: project.schedule.score.placedLessons,
                    unplacedLessons: 0,
                    hardConflicts: 0,
                },
                blockingIssues: [],
                warnings: [
                    { type: 'manual_adjusted', message: '课表包含手动调整，发布前建议复核锁定课节。' },
                    { type: 'restored_published_draft' },
                ],
                reviewItems: [],
            },
            published: {
                status: 'published',
                version: 3,
                publishedAt: '2026-06-10T08:00:00.000Z',
                scheduleId: project.schedule.id,
                note: '教务处发布给七年级使用',
                snapshot: {
                    scheduleId: project.schedule.id,
                    generatedAt: project.schedule.generatedAt,
                    source: project.schedule.source,
                    slotCount: project.schedule.slots.length,
                    fingerprint: '9f2d7c5b4a8e1d0c3b6a594837261504fdecba98765432100123456789abcdef',
                    score: project.schedule.score,
                    publicationSummary: {
                        totalLessons: project.schedule.score.totalLessons,
                        placedLessons: project.schedule.score.placedLessons,
                        unplacedLessons: 0,
                        hardConflicts: 0,
                    },
                    slots: project.schedule.slots,
                },
            },
        },
    };
    const workbook = readWorkbook(buildTimetableExportXlsx(publishedProject, { type: 'class', published: true }));

    assert.match(workbook.combined, /发布信息/);
    assert.match(workbook.combined, /发布版本/);
    assert.match(workbook.combined, /V3/);
    assert.match(workbook.combined, /发布时间/);
    assert.match(workbook.combined, /2026-06-10T08:00:00.000Z/);
    assert.match(workbook.combined, /发布备注/);
    assert.match(workbook.combined, /教务处发布给七年级使用/);
    assert.match(workbook.combined, /发布指纹/);
    assert.match(workbook.combined, /9f2d7c5b4a8e1d0c3b6a594837261504fdecba98765432100123456789abcdef/);
    assert.match(workbook.combined, /发布校验/);
    assert.match(workbook.combined, /已通过/);
    assert.match(workbook.combined, /硬冲突/);
    assert.match(workbook.combined, /未排课时/);
    assert.match(workbook.combined, /恢复发布版/);
    assert.doesNotMatch(workbook.combined, /restored_published_draft/);
});

test('lesson plan export lists roster columns and plan rows', () => {
    const project = scheduledProject();
    const workbook = readWorkbook(buildTimetableExportXlsx(project, { type: 'plans' }));

    assert.match(workbook.workbookXml, /任课信息/);
    // header row labels
    assert.match(workbook.combined, /年级/);
    assert.match(workbook.combined, /周课时/);
    assert.match(workbook.combined, /连堂/);
    // plan content
    assert.match(workbook.combined, /七年级/);
    assert.match(workbook.combined, /语文/);
    assert.match(workbook.combined, /周老师/);
    // double block preference renders as 双连堂
    assert.match(workbook.combined, /双连堂/);
});

test('export still produces a valid workbook when no schedule is attached', () => {
    const project = sampleExportProject();
    const workbook = readWorkbook(buildTimetableExportXlsx(project, { type: 'class' }));

    // owners are still rendered even with an empty schedule
    assert.match(workbook.combined, /七年级1班/);
});
