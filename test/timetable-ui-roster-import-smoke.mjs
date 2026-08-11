import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import * as XLSX from '@e965/xlsx';

import { sampleRosterText } from '../public/js/tools/timetable/forms.js';
import { TIMETABLE_ROSTER_WORKBOOK_PATH } from './fixtures/timetable-workbook-paths.js';
import { withOpenedTimetablePage } from './timetable-ui-smoke-helpers.mjs';

const REAL_WORKBOOK = TIMETABLE_ROSTER_WORKBOOK_PATH;
const ARTIFACT_DIR = path.resolve('artifacts');

async function waitForRosterReview(page, action) {
    const responsePromise = page.waitForResponse(response => (
        response.url().includes('/api/tools/timetable/roster/preview') && response.request().method() === 'POST'
    ), { timeout: 30_000 });
    await action();
    const response = await responsePromise;
    const responseText = await response.text();
    let payload;
    try {
        payload = JSON.parse(responseText);
    } catch {
        throw new Error(`roster preview returned non-JSON: ${response.status()} ${response.url()} ${responseText.slice(0, 240)}`);
    }
    assert.equal(response.status(), 200, JSON.stringify(payload));
    assert.equal(payload.success, true, JSON.stringify(payload));
    await page.waitForFunction(() => document.querySelector('#tt-roster-import-title')?.textContent?.includes('检查任课数据'), null, { timeout: 30_000 });
    return payload.data;
}

async function assertRealRosterPreview(page, preview, format) {
    assert.equal(preview.source, 'local');
    assert.equal(preview.parseSummary.format, format);
    assert.equal(preview.parseSummary.aiAttempted, false);
    assert.equal(preview.parseSummary.aiCallCount, 0);
    assert.equal(preview.draftRows.length, 360);
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
    assert.equal(await page.locator('[data-roster-review-row]').count(), 360);
    await assertRepresentativeRow(page, 2, ['G7-1班', '语文', '刘书涵', '5']);
    await assertRepresentativeRow(page, 181, ['G8-5班', '物理', '余思齐', '2']);
    await assertRepresentativeRow(page, 361, ['G9-10班', '劳动', '顾安然', '1']);
}

async function assertRepresentativeRow(page, sourceRow, expected) {
    const row = page.locator(`[data-roster-source-row="${sourceRow}"]`);
    await row.scrollIntoViewIfNeeded();
    assert.equal(await row.getAttribute('data-roster-source-sheet'), '任课数据');
    const values = await row.locator('[data-roster-field="className"], [data-roster-field="subjectName"], [data-roster-field="teacherName"], [data-roster-field="weeklyHours"]').evaluateAll(elements => elements.map(element => element.value));
    assert.deepEqual(values, expected);
}

async function assertDisplayedRowNumber(page, sourceRow, expectedNumber, expectedTitle) {
    const number = page.locator(`[data-roster-source-row="${sourceRow}"] .tt-roster-review-row-number`);
    assert.equal(await number.innerText(), String(expectedNumber));
    assert.equal(await number.getAttribute('title'), expectedTitle);
}

function buildBiff8Buffer() {
    const workbook = XLSX.read(fs.readFileSync(REAL_WORKBOOK), { type: 'buffer' });
    return XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' });
}

async function rosterScrollPosition(page) {
    return page.evaluate(() => ({
        dialogTop: document.querySelector('#tt-roster-import-dialog')?.scrollTop || 0,
        reviewLeft: document.querySelector('.tt-roster-review-wrap')?.scrollLeft || 0,
    }));
}

async function assertRosterScrollStable(page, expected) {
    const actual = await rosterScrollPosition(page);
    assert.equal(Math.abs(actual.dialogTop - expected.dialogTop) <= 1, true, JSON.stringify({ expected, actual }));
    assert.equal(Math.abs(actual.reviewLeft - expected.reviewLeft) <= 1, true, JSON.stringify({ expected, actual }));
}

async function assertDesktopRosterTableFits(page) {
    const layout = await page.evaluate(() => {
        const wrapElement = document.querySelector('.tt-roster-review-wrap');
        const wrap = wrapElement.getBoundingClientRect();
        const headers = [...document.querySelectorAll('.tt-roster-review-table thead th')].map(header => {
            const rect = header.getBoundingClientRect();
            const helpLabel = header.querySelector('.tt-roster-block-help > span:first-child');
            return { text: (helpLabel?.textContent || header.textContent).trim(), left: rect.left, right: rect.right };
        });
        const row = document.querySelector('[data-roster-review-row]');
        const horizontalPositions = ['行号', '问题', '操作'].map(label => {
            const style = getComputedStyle(row.querySelector(`[data-label="${label}"]`));
            return { label, position: style.position, left: style.left, right: style.right };
        });
        return {
            wrap: { left: wrap.left, right: wrap.right, clientWidth: wrapElement.clientWidth, scrollWidth: wrapElement.scrollWidth },
            headers,
            horizontalPositions,
            overflowX: getComputedStyle(wrapElement).overflowX,
        };
    });
    assert.deepEqual(layout.headers.map(header => header.text.replace(/\s+/g, '')), [
        '行号', '年级', '班级', '课程', '类型', '标签', '教师', '周课时', '连堂', '教室', '课型', '资源', '问题', '操作',
    ]);
    assert.equal(layout.wrap.scrollWidth <= layout.wrap.clientWidth + 1, true, JSON.stringify(layout));
    assert.equal(layout.headers.every(header => header.left >= layout.wrap.left - 1 && header.right <= layout.wrap.right + 1), true, JSON.stringify(layout));
    assert.equal(layout.horizontalPositions.every(item => item.position === 'static' && item.left === 'auto' && item.right === 'auto'), true, JSON.stringify(layout));
    assert.equal(layout.overflowX, 'clip');
    return layout;
}

await mkdir(ARTIFACT_DIR, { recursive: true });

await withOpenedTimetablePage({ port: 3140 }, async ({ page, baseUrl }) => {
    const failedRequests = [];
    const failedResponses = [];
    page.on('requestfailed', request => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`));
    page.on('response', response => {
        if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click('#tt-open-roster-import');
    await page.waitForSelector('#tt-roster-import-dialog');
    assert.match(await page.locator('#tt-roster-import-dialog').innerText(), /支持表格数据，也可尝试自然语言描述/);
    assert.equal(
        await page.locator('#tt-roster-import-text').getAttribute('placeholder'),
        '每条任课一行，支持带表头的表格数据或自然语言描述。\n至少包含：班级、课程、教师、周课时。',
    );
    assert.equal(await page.locator('#tt-fill-roster-sample').innerText(), '填入示例');
    await page.click('#tt-fill-roster-sample');
    assert.equal(await page.locator('#tt-roster-import-text').inputValue(), sampleRosterText());
    const samplePreview = await waitForRosterReview(page, () => page.click('[data-roster-import-submit="text"]'));
    assert.equal(samplePreview.source, 'local');
    assert.equal(samplePreview.parseSummary.aiAttempted, false);
    assert.equal(samplePreview.parseSummary.aiCallCount, 0);
    assert.equal(samplePreview.draftRows.length, 2);
    assert.deepEqual(samplePreview.draftRows.map(row => ({
        subjectName: row.subjectName,
        subjectCategory: row.subjectCategory,
        activityTypes: row.activityTypes,
        requiredResourceTypes: row.requiredResourceTypes,
    })), [{
        subjectName: '语文',
        subjectCategory: 'main',
        activityTypes: ['普通课'],
        requiredResourceTypes: ['普通教室'],
    }, {
        subjectName: '物理',
        subjectCategory: 'lab',
        activityTypes: ['实验课'],
        requiredResourceTypes: ['实验室'],
    }]);
    await page.click('#tt-back-roster-import');
    await page.waitForFunction(() => document.querySelector('#tt-roster-import-title')?.textContent?.includes('导入任课数据'));
    await page.locator('#tt-roster-import-file').setInputFiles(REAL_WORKBOOK);
    const xlsxPreview = await waitForRosterReview(page, () => page.click('[data-roster-import-submit="file"]'));
    await assertRealRosterPreview(page, xlsxPreview, 'xlsx');
    await assertDisplayedRowNumber(page, 2, 1, '第 1 行 · 来源：任课数据 · 源文件第 2 行');
    await assertDisplayedRowNumber(page, 361, 360, '第 360 行 · 来源：任课数据 · 源文件第 361 行');

    assert.match(await page.locator('#tt-roster-import-dialog').innerText(), /本地解析/);
    assert.match(await page.locator('.tt-roster-sheet-review').innerText(), /XLSX · 1\/1 个工作表 · 本地 360 行 · AI 未调用/);
    const sheetToggle = page.locator('[data-roster-sheet-toggle="sheet-1"]');
    await sheetToggle.uncheck();
    await page.waitForFunction(() => document.querySelectorAll('[data-roster-review-row]').length === 0);
    assert.match(await page.locator('.tt-roster-stats').innerText(), /任课\s*0/);
    await sheetToggle.check();
    await page.waitForFunction(() => document.querySelectorAll('[data-roster-review-row]').length === 360);

    await assertDesktopRosterTableFits(page);

    const reviewActions = page.locator('.tt-roster-review-actions');
    assert.equal(await page.locator('#tt-roster-bulk-text').count(), 0);
    assert.deepEqual(await reviewActions.locator('button').allTextContents(), [
        '返回导入方式', '新增行', '批量追加', '取消', '确认导入',
    ]);
    assert.equal(await reviewActions.evaluate(element => getComputedStyle(element).position), 'sticky');

    const preservedTags = '主科、返回后仍保留';
    const rowTags = page.locator('[data-roster-source-row="2"] [data-roster-field="subjectTags"]');
    await rowTags.fill(preservedTags);
    await page.click('#tt-back-roster-import');
    await page.waitForFunction(() => document.querySelector('#tt-roster-import-title')?.textContent?.includes('导入任课数据'));
    assert.match(await page.locator('#tt-roster-import-dialog').innerText(), /当前保留\s*360\s*条复核数据/);
    assert.equal(await page.locator('#tt-resume-roster-review').innerText(), '继续复核（360 条）');
    await page.click('#tt-resume-roster-review');
    await page.waitForFunction(() => document.querySelectorAll('[data-roster-review-row]').length === 360);
    assert.equal(await rowTags.inputValue(), preservedTags);

    const editableActivity = page.locator('[data-roster-source-row="2"] [data-roster-field="activityTypes"]');
    const editableResource = page.locator('[data-roster-source-row="2"] [data-roster-field="requiredResourceTypes"]');
    await editableActivity.scrollIntoViewIfNeeded();
    assert.equal(await editableActivity.inputValue(), '');
    assert.equal(await editableResource.inputValue(), '');
    assert.equal(await page.locator('[data-roster-source-row="2"] [data-roster-field="roomName"]').getAttribute('title'), 'G7-01本班教室');
    const fieldVisuals = await page.locator('[data-roster-source-row="2"]').evaluate(row => {
        const measure = element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
                height: rect.height,
                borderRadius: style.borderRadius,
                backgroundColor: style.backgroundColor,
                fontSize: style.fontSize,
            };
        };
        return {
            category: measure(row.querySelector('[data-roster-field="subjectCategory"]')),
            activity: measure(row.querySelector('[data-roster-field="activityTypes"]')),
            resource: measure(row.querySelector('[data-roster-field="requiredResourceTypes"]')),
        };
    });
    assert.equal(Math.abs(fieldVisuals.activity.height - fieldVisuals.category.height) <= 1, true, JSON.stringify(fieldVisuals));
    assert.equal(Math.abs(fieldVisuals.resource.height - fieldVisuals.category.height) <= 1, true, JSON.stringify(fieldVisuals));
    assert.equal(fieldVisuals.activity.borderRadius, fieldVisuals.category.borderRadius);
    assert.equal(fieldVisuals.activity.backgroundColor, fieldVisuals.category.backgroundColor);
    assert.equal(fieldVisuals.activity.fontSize, fieldVisuals.category.fontSize);

    const desktopScroll = await rosterScrollPosition(page);
    await editableActivity.selectOption('实验课');
    await assertRosterScrollStable(page, desktopScroll);
    assert.equal(await editableActivity.inputValue(), '实验课');
    assert.deepEqual(await editableActivity.locator('option:checked').allTextContents(), ['实验课']);
    await editableActivity.selectOption('答疑');
    await assertRosterScrollStable(page, desktopScroll);
    assert.equal(await editableActivity.inputValue(), '答疑');
    assert.deepEqual(await editableActivity.locator('option:checked').allTextContents(), ['答疑']);
    assert.equal(await editableActivity.getAttribute('title'), '答疑');

    await editableResource.selectOption('实验室');
    await assertRosterScrollStable(page, desktopScroll);
    assert.equal(await editableResource.inputValue(), '实验室');
    assert.deepEqual(await editableResource.locator('option:checked').allTextContents(), ['实验室']);
    await editableResource.selectOption('计算机教室');
    await assertRosterScrollStable(page, desktopScroll);
    assert.equal(await editableResource.inputValue(), '计算机教室');
    assert.deepEqual(await editableResource.locator('option:checked').allTextContents(), ['计算机教室']);
    assert.equal(await editableResource.getAttribute('title'), '计算机教室');
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-roster-import-single-select-desktop.png') });

    await editableActivity.selectOption('');
    await editableResource.selectOption('');
    await assertRosterScrollStable(page, desktopScroll);
    assert.equal(await editableActivity.inputValue(), '');
    assert.equal(await editableResource.inputValue(), '');
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-roster-import-review-desktop.png') });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.tt-roster-review-table thead')).display !== 'none');
    await assertDesktopRosterTableFits(page);

    await page.setViewportSize({ width: 1279, height: 900 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.tt-roster-review-table thead')).display === 'none');
    const compactLayout = await page.evaluate(() => {
        const wrap = document.querySelector('.tt-roster-review-wrap');
        const row = document.querySelector('[data-roster-review-row]');
        const activityCell = row.querySelector('[data-label="课型"]');
        const rowRect = row.getBoundingClientRect();
        const dialogRect = document.querySelector('#tt-roster-import-dialog').getBoundingClientRect();
        return {
            headDisplay: getComputedStyle(document.querySelector('.tt-roster-review-table thead')).display,
            rowDisplay: getComputedStyle(row).display,
            cellDisplay: getComputedStyle(activityCell).display,
            activityLabel: getComputedStyle(activityCell, '::before').content,
            scrollWidth: wrap.scrollWidth,
            clientWidth: wrap.clientWidth,
            rowLeft: rowRect.left,
            rowRight: rowRect.right,
            dialogLeft: dialogRect.left,
            dialogRight: dialogRect.right,
        };
    });
    assert.equal(compactLayout.headDisplay, 'none', JSON.stringify(compactLayout));
    assert.equal(compactLayout.rowDisplay, 'grid', JSON.stringify(compactLayout));
    assert.equal(compactLayout.cellDisplay, 'grid', JSON.stringify(compactLayout));
    assert.match(compactLayout.activityLabel, /课型/);
    assert.equal(compactLayout.scrollWidth <= compactLayout.clientWidth + 1, true, JSON.stringify(compactLayout));
    assert.equal(compactLayout.rowLeft >= compactLayout.dialogLeft && compactLayout.rowRight <= compactLayout.dialogRight, true, JSON.stringify(compactLayout));
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-roster-import-review-compact.png') });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-roster-source-row="2"]').scrollIntoViewIfNeeded();
    const mobileLayout = await page.evaluate(() => ({
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        dialog: (() => {
            const rect = document.querySelector('#tt-roster-import-dialog').getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: rect.width };
        })(),
    }));
    assert.equal(mobileLayout.documentWidth <= mobileLayout.viewport, true, JSON.stringify(mobileLayout));
    assert.equal(mobileLayout.dialog.left >= 0 && mobileLayout.dialog.right <= mobileLayout.viewport, true, JSON.stringify(mobileLayout));
    await editableActivity.selectOption('上机课');
    assert.equal(await editableActivity.inputValue(), '上机课');
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-roster-import-review-mobile.png') });
    await editableActivity.selectOption('');
    assert.equal(await editableActivity.inputValue(), '');

    await page.setViewportSize({ width: 1440, height: 900 });
    const duplicateValues = await page.locator('[data-roster-source-row="2"]').evaluate(row => ({
        grade: row.querySelector('[data-roster-field="grade"]')?.value,
        className: row.querySelector('[data-roster-field="className"]')?.value,
        subjectName: row.querySelector('[data-roster-field="subjectName"]')?.value,
        teacherName: row.querySelector('[data-roster-field="teacherName"]')?.value,
        weeklyHours: row.querySelector('[data-roster-field="weeklyHours"]')?.value,
    }));
    const appendText = [
        '年级,班级,课程,教师,周课时,连堂',
        [
            duplicateValues.grade,
            duplicateValues.className,
            duplicateValues.subjectName,
            duplicateValues.teacherName,
            duplicateValues.weeklyHours,
            '单节',
        ].join(','),
        '九年级,G9-11班,数学,追加老师,3,单节',
    ].join('\n');
    await page.click('#tt-open-roster-append');
    await page.waitForSelector('#tt-roster-append-dialog');
    const appendDialogLayout = await page.locator('#tt-roster-append-dialog').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth };
    });
    assert.equal(appendDialogLayout.left >= 0 && appendDialogLayout.right <= appendDialogLayout.viewport, true, JSON.stringify(appendDialogLayout));
    await page.locator('#tt-roster-append-text').fill(appendText);
    const appendPreview = await waitForRosterReview(page, () => page.click('#tt-submit-roster-append'));
    assert.equal(appendPreview.draftRows.length, 2);
    await page.waitForFunction(() => document.querySelectorAll('[data-roster-review-row]').length === 362);
    assert.equal(await page.locator('[data-roster-source-sheet="追加文本"]').count(), 2);
    assert.match(await page.locator('#tt-roster-import-dialog').innerText(), /已追加\s*2\s*行/);
    assert.match(await page.locator('#tt-roster-import-dialog').innerText(), /存在重复任课/);
    const firstAppendedRow = page.locator('[data-roster-source-sheet="追加文本"]').first();
    const secondAppendedRow = page.locator('[data-roster-source-sheet="追加文本"]').nth(1);
    assert.equal(await firstAppendedRow.locator('.tt-roster-review-row-number').innerText(), '361');
    assert.equal(await secondAppendedRow.locator('.tt-roster-review-row-number').innerText(), '362');
    assert.match(await firstAppendedRow.getAttribute('class'), /tt-roster-review-row--duplicate/);
    assert.equal(await firstAppendedRow.locator('.tt-roster-review-issue--duplicate').innerText(), '重复');
    assert.equal(
        await firstAppendedRow.locator('.tt-roster-review-issue--duplicate').getAttribute('data-roster-jump-row'),
        await page.locator('[data-roster-source-sheet="任课数据"][data-roster-source-row="2"]').getAttribute('data-roster-review-row'),
    );
    assert.doesNotMatch(await secondAppendedRow.getAttribute('class'), /tt-roster-review-row--duplicate/);
    await page.waitForFunction(() => {
        const row = document.querySelector('[data-roster-source-sheet="追加文本"]');
        if (!row) return false;
        const rect = row.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight;
    });
    assert.equal(await firstAppendedRow.locator('[data-roster-field="teacherName"]').inputValue(), duplicateValues.teacherName);
    await page.waitForFunction(() => !document.querySelector('[data-roster-source-sheet="追加文本"]')?.classList.contains('tt-roster-review-row--focused'));
    const duplicateVisuals = await page.evaluate(() => {
        const duplicate = document.querySelector('[data-roster-source-sheet="追加文本"]');
        const normal = document.querySelectorAll('[data-roster-source-sheet="追加文本"]')[1];
        return {
            duplicateBackground: getComputedStyle(duplicate.cells[1]).backgroundColor,
            normalBackground: getComputedStyle(normal.cells[1]).backgroundColor,
            leftMarker: getComputedStyle(duplicate.cells[0]).boxShadow,
        };
    });
    assert.notEqual(duplicateVisuals.duplicateBackground, duplicateVisuals.normalBackground, JSON.stringify(duplicateVisuals));
    assert.notEqual(duplicateVisuals.leftMarker, 'none', JSON.stringify(duplicateVisuals));
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-roster-import-append-desktop.png') });

    await firstAppendedRow.locator('.tt-roster-review-issue--duplicate').click();
    const originalDuplicateRow = page.locator('[data-roster-source-sheet="任课数据"][data-roster-source-row="2"]');
    await page.waitForFunction(() => document.querySelector('[data-roster-source-sheet="任课数据"][data-roster-source-row="2"]')?.classList.contains('tt-roster-review-row--focused'));
    assert.equal(await originalDuplicateRow.locator('.tt-roster-review-row-number').innerText(), '1');

    await page.setViewportSize({ width: 390, height: 844 });
    await firstAppendedRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-roster-import-duplicate-mobile.png') });
    const mobileActionLayout = await page.evaluate(() => {
        const actions = document.querySelector('.tt-roster-review-actions');
        const rect = actions.getBoundingClientRect();
        return {
            viewport: innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            left: rect.left,
            right: rect.right,
            scrollHeight: actions.scrollHeight,
            clientHeight: actions.clientHeight,
        };
    });
    assert.equal(mobileActionLayout.documentWidth <= mobileActionLayout.viewport, true, JSON.stringify(mobileActionLayout));
    assert.equal(mobileActionLayout.left >= 0 && mobileActionLayout.right <= mobileActionLayout.viewport, true, JSON.stringify(mobileActionLayout));
    await page.click('#tt-open-roster-append');
    await page.waitForSelector('#tt-roster-append-dialog');
    const mobileAppendLayout = await page.locator('#tt-roster-append-dialog').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return {
            viewport: innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            left: rect.left,
            right: rect.right,
            width: rect.width,
        };
    });
    assert.equal(mobileAppendLayout.documentWidth <= mobileAppendLayout.viewport, true, JSON.stringify(mobileAppendLayout));
    assert.equal(mobileAppendLayout.left >= 0 && mobileAppendLayout.right <= mobileAppendLayout.viewport, true, JSON.stringify(mobileAppendLayout));
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-roster-import-append-mobile.png') });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#tt-roster-append-dialog'));

    await page.setViewportSize({ width: 1440, height: 900 });
    const importResponsePromise = page.waitForResponse(response => response.url().includes('/api/tools/timetable/roster/import'), { timeout: 30_000 });
    await page.click('#tt-confirm-roster-import');
    const importResponse = await importResponsePromise;
    assert.equal(importResponse.status(), 200);
    await page.waitForFunction(() => !document.querySelector('#tt-roster-import-dialog'), null, { timeout: 30_000 });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-roster-import-complete.png') });

    const stored = await fetch(`${baseUrl}/api/tools/timetable/bootstrap`).then(response => response.json());
    assert.equal(stored.success, true);
    assert.equal(stored.data.project.lessonPlans.length, 362);
    assert.equal(stored.data.project.rooms.length, 43);
    assert.equal(stored.data.project.lessonPlans.filter(plan => plan.activityTypes.includes('实验课')).length, 50);
    assert.equal(stored.data.project.lessonPlans.filter(plan => plan.requiredResourceTypes.includes('实验室')).length, 0);
    assert.equal(stored.data.project.lessonPlans.filter(plan => plan.requiredResourceTypes.includes('计算机教室')).length, 0);
    assert.equal(stored.data.project.lessonPlans[179].allowedRoomIds.length, 2);

    const dataPanel = page.locator('[data-workflow-step="data"].tt-workflow-panel');
    if (await dataPanel.getAttribute('class').then(value => !String(value || '').includes('is-open'))) {
        await page.click('[data-tt-section-toggle="data"]');
    }
    await page.click('#tt-reopen-roster-import');
    await page.locator('#tt-roster-import-file').setInputFiles({
        name: '真实学校整学期任课数据.xls',
        mimeType: 'application/vnd.ms-excel',
        buffer: buildBiff8Buffer(),
    });
    const xlsPreview = await waitForRosterReview(page, () => page.click('[data-roster-import-submit="file"]'));
    await assertRealRosterPreview(page, xlsPreview, 'xls');
    await page.click('#tt-cancel-roster-import');
    await page.waitForFunction(() => !document.querySelector('#tt-roster-import-dialog'));

    assert.deepEqual(failedRequests, []);
    assert.deepEqual(failedResponses, []);
});

console.log('timetable roster import browser smoke passed');
