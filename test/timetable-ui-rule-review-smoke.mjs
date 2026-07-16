import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import AdmZip from 'adm-zip';

import { withOpenedTimetablePage } from './timetable-ui-smoke-helpers.mjs';
import { createCompleteNaturalLanguage137Project } from './fixtures/timetable-natural-language-137-project.js';

const ARTIFACT_DIR = path.resolve('artifacts');
const REAL_ROSTER_FILE = path.resolve('真实学校整学期任课数据.xlsx');

function xmlEscape(value = '') {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
    })[char]);
}

function buildConstraintWorkbook(rows = []) {
    const strings = rows.flat();
    const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">
${strings.map(value => `<si><t>${xmlEscape(value)}</t></si>`).join('')}
</sst>`;
    let stringIndex = 0;
    const sheetRows = rows.map((row, rowIndex) => {
        const cells = row.map((_, columnIndex) => {
            const ref = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
            return `<c r="${ref}" t="s"><v>${stringIndex++}</v></c>`;
        }).join('');
        return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    const zip = new AdmZip();
    zip.addFile('xl/sharedStrings.xml', Buffer.from(sharedStrings, 'utf8'));
    zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="AI约束建议" sheetId="1" r:id="rId1"/></sheets>
</workbook>`, 'utf8'));
    zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`, 'utf8'));
    zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`, 'utf8'));
    return zip.toBuffer();
}

async function main() {
    await mkdir(ARTIFACT_DIR, { recursive: true });
    const realConstraintFixture = JSON.parse(await readFile(
        new URL('./fixtures/timetable-natural-language-137.json', import.meta.url),
        'utf8',
    ));
    assert.equal(realConstraintFixture.length, 137);

    await withOpenedTimetablePage({ port: 3139 }, async ({ page }) => {
        const clickByScript = async selector => {
            await page.locator(selector).evaluate(element => element.click());
        };
        const dialogs = [];
        page.on('dialog', dialog => {
            dialogs.push({ type: dialog.type(), message: dialog.message() });
            dialog.accept();
        });

        const clearRecognizedConstraints = async () => {
            await clickByScript('[data-action="clear-all-constraints"]');
            await page.waitForFunction(
                () => !document.querySelector('.tt-requirement-workbench')
                    && document.querySelectorAll('.tt-constraint-card').length === 0,
                { timeout: 10000 },
            );
        };

        const recognizedText = async () => page.textContent('[data-constraint-dialog-overlay]');
        const constraintFooterLabels = async () => page.locator('.tt-constraint-dialog-actions .tt-btn')
            .evaluateAll(buttons => buttons.map(button => (button.textContent || '').replace(/\s+/g, ' ').trim()));

        await page.click('#tt-open-roster-import');
        await page.waitForSelector('#tt-roster-import-dialog', { timeout: 10000 });

        await page.click('#tt-fill-roster-sample');
        await page.click('[data-roster-import-submit="text"]');
        await page.waitForFunction(() => {
            const title = document.querySelector('#tt-roster-import-title');
            return title && /检查任课数据/.test(title.textContent || '');
        }, { timeout: 20000 });
        await page.click('#tt-confirm-roster-import');
        await page.waitForFunction(() => !document.querySelector('#tt-roster-import-dialog'), { timeout: 20000 });

        await page.evaluate(() => {
            const toggle = document.querySelector('[data-tt-section-toggle="rules"]');
            if (toggle?.getAttribute('aria-expanded') !== 'true') toggle.click();
        });
        await page.waitForFunction(() => {
            const panel = document.querySelector('[data-workflow-step="rules"]');
            return panel && panel.classList.contains('is-open');
        }, { timeout: 10000 });

        await page.click('#tt-open-rule-review');
        await page.waitForSelector('[data-constraint-dialog-overlay]', { timeout: 10000 });
        assert.equal(await page.locator('[data-smart-workbench-root]').count(), 0);
        assert.equal(await page.locator('.tt-quick-examples, [data-action="use-example"], .tt-constraint-intake-note').count(), 0);
        assert.deepEqual(await constraintFooterLabels(), ['取消', '开始理解']);

        const assertIntakeLayout = async () => {
            const layout = await page.evaluate(() => {
                const dialogElement = document.querySelector('.tt-constraint-dialog');
                const dialog = dialogElement.getBoundingClientRect();
                const stagebar = document.querySelector('.tt-constraint-stagebar').getBoundingClientRect();
                const flowWrapElement = document.querySelector('.tt-constraint-flow-wrap');
                const flowWrap = flowWrapElement.getBoundingClientRect();
                const intakeElement = document.querySelector('.tt-constraint-intake-panel');
                const intake = intakeElement.getBoundingClientRect();
                const intakeStyle = getComputedStyle(intakeElement);
                const modeRow = document.querySelector('.tt-constraint-mode-row').getBoundingClientRect();
                const tabs = document.querySelector('.tt-constraint-input-tabs').getBoundingClientRect();
                const textarea = document.querySelector('#tt-constraint-text-input').getBoundingClientRect();
                const footer = document.querySelector('.tt-constraint-dialog-actions').getBoundingClientRect();
                const buttons = [...document.querySelectorAll('.tt-constraint-dialog-actions .tt-btn')].map(button => {
                    const rect = button.getBoundingClientRect();
                    return {
                        left: rect.left,
                        right: rect.right,
                        height: rect.height,
                        clientWidth: button.clientWidth,
                        scrollWidth: button.scrollWidth,
                        whiteSpace: getComputedStyle(button).whiteSpace,
                    };
                });
                return {
                    viewportWidth: window.innerWidth,
                    viewportHeight: window.innerHeight,
                    documentWidth: document.documentElement.scrollWidth,
                    dialog: {
                        left: dialog.left,
                        right: dialog.right,
                        top: dialog.top,
                        bottom: dialog.bottom,
                        width: dialog.width,
                        height: dialog.height,
                    },
                    stagebar: { left: stagebar.left, right: stagebar.right },
                    flowWrap: {
                        left: flowWrap.left,
                        right: flowWrap.right,
                        flowCount: flowWrapElement.querySelectorAll(':scope > .tt-constraint-flow').length,
                    },
                    intake: {
                        left: intake.left,
                        right: intake.right,
                        borderTopWidth: intakeStyle.borderTopWidth,
                        boxShadow: intakeStyle.boxShadow,
                        paddingTop: intakeStyle.paddingTop,
                    },
                    modeRow: { left: modeRow.left, right: modeRow.right },
                    tabs: { left: tabs.left, right: tabs.right },
                    textareaBottom: textarea.bottom,
                    footerTop: footer.top,
                    emptyStatusCount: document.querySelectorAll('.tt-constraint-input-status').length,
                    buttons,
                };
            });
            assert.equal(layout.documentWidth <= layout.viewportWidth, true, JSON.stringify(layout));
            assert.equal(layout.footerTop >= layout.textareaBottom, true, JSON.stringify(layout));
            assert.equal(layout.footerTop - layout.textareaBottom <= 40, true, JSON.stringify(layout));
            assert.equal(layout.dialog.bottom <= layout.viewportHeight, true, JSON.stringify(layout));
            assert.equal(layout.flowWrap.flowCount, 1, JSON.stringify(layout));
            assert.equal(Math.abs(layout.flowWrap.left - layout.stagebar.left) <= 1, true, JSON.stringify(layout));
            assert.equal(Math.abs(layout.flowWrap.right - layout.stagebar.right) <= 1, true, JSON.stringify(layout));
            assert.equal(layout.intake.borderTopWidth, '0px', JSON.stringify(layout));
            assert.equal(layout.intake.boxShadow, 'none', JSON.stringify(layout));
            assert.equal(layout.intake.paddingTop, '0px', JSON.stringify(layout));
            assert.equal(Math.abs(layout.tabs.left - layout.modeRow.left) <= 1, true, JSON.stringify(layout));
            assert.equal(layout.tabs.right <= layout.modeRow.right + 1, true, JSON.stringify(layout));
            assert.equal(layout.emptyStatusCount, 0, JSON.stringify(layout));
            if (layout.viewportWidth > 760) {
                assert.equal(layout.dialog.width <= 781, true, JSON.stringify(layout));
            }
            assert.equal(layout.buttons.every(button => (
                button.left >= layout.dialog.left - 1
                && button.right <= layout.dialog.right + 1
                && button.height <= 42
                && button.scrollWidth <= button.clientWidth + 1
                && button.whiteSpace === 'nowrap'
            )), true, JSON.stringify(layout));
        };

        const assertDesktopReviewLayout = async ({ minReviewHeight = 220 } = {}) => {
            const layout = await page.evaluate(() => {
                const dialog = document.querySelector('.tt-constraint-dialog').getBoundingClientRect();
                const bodyElement = document.querySelector('.tt-constraint-dialog-body--review');
                const body = bodyElement.getBoundingClientRect();
                const summary = document.querySelector('[data-constraint-input-summary]').getBoundingClientRect();
                const workbenchElement = document.querySelector('.tt-requirement-workbench');
                const workbench = workbenchElement.getBoundingClientRect();
                const workbenchStyle = getComputedStyle(workbenchElement);
                const workbenchHeaderElement = document.querySelector('.tt-requirement-workbench-header');
                const workbenchHeader = workbenchHeaderElement.getBoundingClientRect();
                const reviewSummaryElement = document.querySelector('.tt-requirement-review-summary');
                const reviewSummary = reviewSummaryElement.getBoundingClientRect();
                const reviewElement = document.querySelector('.tt-requirement-review-layout');
                const review = reviewElement.getBoundingClientRect();
                const filterElement = document.querySelector('.tt-requirement-filter-bar');
                const filter = filterElement.getBoundingClientRect();
                const filterStyle = getComputedStyle(filterElement);
                const tableElement = document.querySelector('.tt-requirement-table');
                const table = tableElement.getBoundingClientRect();
                const tableBodyElement = document.querySelector('.tt-requirement-table-body');
                const detailElement = document.querySelector('.tt-requirement-detail');
                const detail = detailElement.getBoundingClientRect();
                const footer = document.querySelector('.tt-constraint-dialog-actions').getBoundingClientRect();
                return {
                    viewportWidth: window.innerWidth,
                    viewportHeight: window.innerHeight,
                    documentWidth: document.documentElement.scrollWidth,
                    dialog: {
                        left: dialog.left,
                        right: dialog.right,
                        top: dialog.top,
                        bottom: dialog.bottom,
                        width: dialog.width,
                        height: dialog.height,
                    },
                    body: { top: body.top, bottom: body.bottom },
                    summary: { left: summary.left, right: summary.right, top: summary.top, bottom: summary.bottom },
                    workbench: {
                        top: workbench.top,
                        bottom: workbench.bottom,
                        borderTopWidth: workbenchStyle.borderTopWidth,
                        boxShadow: workbenchStyle.boxShadow,
                    },
                    workbenchHeader: { top: workbenchHeader.top, bottom: workbenchHeader.bottom },
                    reviewSummary: {
                        top: reviewSummary.top,
                        bottom: reviewSummary.bottom,
                        height: reviewSummary.height,
                        parentClass: reviewSummaryElement.parentElement?.className || '',
                    },
                    reviewSummaryItems: [...reviewSummaryElement.children].map(item => {
                        const rect = item.getBoundingClientRect();
                        return {
                            height: rect.height,
                            clientWidth: item.clientWidth,
                            scrollWidth: item.scrollWidth,
                        };
                    }),
                    sections: [...workbenchElement.children]
                        .filter(element => element.matches([
                            '.tt-requirement-workbench-header',
                            '.tt-constraint-binding-panel',
                            '.tt-requirement-review-summary',
                            '.tt-requirement-filter-bar',
                            '.tt-requirement-review-layout',
                        ].join(',')))
                        .map(element => {
                            const rect = element.getBoundingClientRect();
                            return { className: element.className, top: rect.top, bottom: rect.bottom };
                        }),
                    filter: {
                        top: filter.top,
                        bottom: filter.bottom,
                        clientHeight: filterElement.clientHeight,
                        scrollHeight: filterElement.scrollHeight,
                        overflowX: filterStyle.overflowX,
                        overflowY: filterStyle.overflowY,
                    },
                    filterButtons: [...filterElement.querySelectorAll('.tt-requirement-filter')].map(button => {
                        const rect = button.getBoundingClientRect();
                        return { top: rect.top, bottom: rect.bottom };
                    }),
                    review: { top: review.top, bottom: review.bottom, height: review.height },
                    table: { top: table.top, bottom: table.bottom },
                    tableBodyOverflowY: getComputedStyle(tableBodyElement).overflowY,
                    detail: { top: detail.top, bottom: detail.bottom },
                    detailOverflowY: getComputedStyle(detailElement).overflowY,
                    footerTop: footer.top,
                };
            });
            assert.equal(layout.documentWidth <= layout.viewportWidth, true, JSON.stringify(layout));
            assert.equal(layout.dialog.width <= Math.min(1120, layout.viewportWidth - 48) + 2, true, JSON.stringify(layout));
            assert.equal(layout.dialog.height <= Math.min(820, layout.viewportHeight - 48) + 2, true, JSON.stringify(layout));
            assert.equal(layout.dialog.left >= 23 && layout.dialog.right <= layout.viewportWidth - 23, true, JSON.stringify(layout));
            assert.equal(layout.dialog.top >= 23 && layout.dialog.bottom <= layout.viewportHeight - 23, true, JSON.stringify(layout));
            assert.equal(layout.summary.left >= layout.dialog.left && layout.summary.right <= layout.dialog.right, true, JSON.stringify(layout));
            assert.equal(layout.summary.top >= layout.body.top && layout.summary.bottom < layout.workbench.top, true, JSON.stringify(layout));
            assert.equal(layout.workbench.bottom <= layout.body.bottom + 1 && layout.workbench.bottom <= layout.footerTop + 1, true, JSON.stringify(layout));
            assert.equal(layout.workbench.borderTopWidth, '0px', JSON.stringify(layout));
            assert.equal(layout.workbench.boxShadow, 'none', JSON.stringify(layout));
            assert.match(layout.reviewSummary.parentClass, /tt-requirement-workbench-meta/, JSON.stringify(layout));
            assert.equal(layout.reviewSummary.top >= layout.workbenchHeader.top - 1, true, JSON.stringify(layout));
            assert.equal(layout.reviewSummary.bottom <= layout.workbenchHeader.bottom + 1, true, JSON.stringify(layout));
            assert.equal(layout.reviewSummaryItems.every(item => (
                item.height <= 26 && item.scrollWidth <= item.clientWidth + 1
            )), true, JSON.stringify(layout));
            assert.equal(layout.sections.every((section, index, sections) => (
                index === 0 || section.top >= sections[index - 1].bottom - 1
            )), true, JSON.stringify(layout));
            assert.equal(layout.filter.scrollHeight <= layout.filter.clientHeight + 1, true, JSON.stringify(layout));
            assert.equal(layout.filter.overflowX === 'auto' && layout.filter.overflowY === 'hidden', true, JSON.stringify(layout));
            assert.equal(layout.filterButtons.every(button => (
                button.top >= layout.filter.top - 1 && button.bottom <= layout.filter.bottom + 1
            )), true, JSON.stringify(layout));
            assert.equal(layout.review.top >= layout.filter.bottom - 1, true, JSON.stringify(layout));
            assert.equal(layout.review.height >= minReviewHeight, true, JSON.stringify(layout));
            assert.equal(Math.abs(layout.table.top - layout.detail.top) <= 1, true, JSON.stringify(layout));
            assert.equal(layout.table.bottom <= layout.review.bottom + 1, true, JSON.stringify(layout));
            assert.equal(layout.detail.bottom <= layout.review.bottom + 1, true, JSON.stringify(layout));
            assert.equal(layout.tableBodyOverflowY, 'auto', JSON.stringify(layout));
            assert.equal(layout.detailOverflowY, 'auto', JSON.stringify(layout));
        };

        const assertDesktopIndependentScrolling = async () => {
            const scrolling = await page.evaluate(() => {
                const inspectScroller = selector => {
                    const element = document.querySelector(selector);
                    const originalScrollTop = element.scrollTop;
                    element.scrollTop = element.scrollHeight;
                    const result = {
                        clientHeight: element.clientHeight,
                        scrollHeight: element.scrollHeight,
                        scrollTop: element.scrollTop,
                        overflowY: getComputedStyle(element).overflowY,
                    };
                    element.scrollTop = originalScrollTop;
                    return result;
                };
                return {
                    table: inspectScroller('.tt-requirement-table-body'),
                    detail: inspectScroller('.tt-requirement-detail'),
                };
            });
            assert.equal(scrolling.table.overflowY, 'auto', JSON.stringify(scrolling));
            assert.equal(scrolling.detail.overflowY, 'auto', JSON.stringify(scrolling));
            assert.equal(scrolling.table.scrollHeight > scrolling.table.clientHeight, true, JSON.stringify(scrolling));
            assert.equal(scrolling.detail.scrollHeight > scrolling.detail.clientHeight, true, JSON.stringify(scrolling));
            assert.equal(scrolling.table.scrollTop > 0, true, JSON.stringify(scrolling));
            assert.equal(scrolling.detail.scrollTop > 0, true, JSON.stringify(scrolling));
        };

        const assertHeaderActionTheme = async () => {
            const theme = await page.evaluate(() => {
                const normalizeColor = value => {
                    const probe = document.createElement('span');
                    probe.style.color = value;
                    document.body.appendChild(probe);
                    const color = getComputedStyle(probe).color;
                    probe.remove();
                    return color;
                };
                const workbenchStyle = getComputedStyle(document.querySelector('.tt-workbench'));
                const aiButton = document.querySelector('[data-action="start-ai-chat"]');
                const closeButton = document.querySelector('[data-action="close-constraint-dialog"]');
                return {
                    expectedText: normalizeColor(workbenchStyle.getPropertyValue('--tt-text')),
                    expectedSoft: normalizeColor(workbenchStyle.getPropertyValue('--tt-bg-soft')),
                    aiColor: aiButton ? getComputedStyle(aiButton).color : null,
                    closeBackground: getComputedStyle(closeButton).backgroundColor,
                };
            });
            const colorChannels = value => (String(value || '').match(/[\d.]+/g) || []).map(Number);
            const maxColorDelta = (actual, expected) => {
                const actualChannels = colorChannels(actual);
                const expectedChannels = colorChannels(expected);
                return Math.max(...expectedChannels.map((value, index) => Math.abs(value - (actualChannels[index] ?? value))));
            };
            if (theme.aiColor) assert.equal(maxColorDelta(theme.aiColor, theme.expectedText) <= 4, true, JSON.stringify(theme));
            assert.equal(maxColorDelta(theme.closeBackground, theme.expectedSoft) <= 4, true, JSON.stringify(theme));
        };

        const assertMobileReviewLayout = async () => {
            const layout = await page.evaluate(() => {
                const dialog = document.querySelector('.tt-constraint-dialog').getBoundingClientRect();
                const bodyElement = document.querySelector('.tt-constraint-dialog-body--review');
                const body = bodyElement.getBoundingClientRect();
                const summary = document.querySelector('[data-constraint-input-summary]').getBoundingClientRect();
                const workbenchElement = document.querySelector('.tt-requirement-workbench');
                const workbenchHeader = document.querySelector('.tt-requirement-workbench-header').getBoundingClientRect();
                const reviewSummaryElement = document.querySelector('.tt-requirement-review-summary');
                const reviewSummary = reviewSummaryElement.getBoundingClientRect();
                const filterElement = document.querySelector('.tt-requirement-filter-bar');
                const filter = filterElement.getBoundingClientRect();
                const filterStyle = getComputedStyle(filterElement);
                const footer = document.querySelector('.tt-constraint-dialog-actions').getBoundingClientRect();
                return {
                    viewport: { width: window.innerWidth, height: window.innerHeight },
                    documentWidth: document.documentElement.scrollWidth,
                    dialog: { left: dialog.left, right: dialog.right, bottom: dialog.bottom },
                    body: {
                        left: body.left,
                        right: body.right,
                        bottom: body.bottom,
                        scrollHeight: bodyElement.scrollHeight,
                        clientHeight: bodyElement.clientHeight,
                    },
                    summary: { left: summary.left, right: summary.right },
                    workbenchHeader: { top: workbenchHeader.top, bottom: workbenchHeader.bottom },
                    reviewSummary: {
                        top: reviewSummary.top,
                        bottom: reviewSummary.bottom,
                        parentClass: reviewSummaryElement.parentElement?.className || '',
                    },
                    reviewSummaryItems: [...reviewSummaryElement.children].map(item => {
                        const rect = item.getBoundingClientRect();
                        return {
                            height: rect.height,
                            clientWidth: item.clientWidth,
                            scrollWidth: item.scrollWidth,
                        };
                    }),
                    sections: [...workbenchElement.children]
                        .filter(element => element.matches([
                            '.tt-requirement-workbench-header',
                            '.tt-constraint-binding-panel',
                            '.tt-requirement-review-summary',
                            '.tt-requirement-filter-bar',
                            '.tt-requirement-review-layout',
                        ].join(',')))
                        .map(element => {
                            const rect = element.getBoundingClientRect();
                            return { className: element.className, top: rect.top, bottom: rect.bottom };
                        }),
                    filter: {
                        top: filter.top,
                        bottom: filter.bottom,
                        clientHeight: filterElement.clientHeight,
                        scrollHeight: filterElement.scrollHeight,
                        overflowX: filterStyle.overflowX,
                        overflowY: filterStyle.overflowY,
                    },
                    filterButtons: [...filterElement.querySelectorAll('.tt-requirement-filter')].map(button => {
                        const rect = button.getBoundingClientRect();
                        return { top: rect.top, bottom: rect.bottom };
                    }),
                    footer: { top: footer.top, bottom: footer.bottom },
                };
            });
            assert.equal(layout.documentWidth <= layout.viewport.width, true, JSON.stringify(layout));
            assert.equal(layout.dialog.left >= 0 && layout.dialog.right <= layout.viewport.width, true, JSON.stringify(layout));
            assert.equal(layout.summary.left >= layout.body.left && layout.summary.right <= layout.body.right, true, JSON.stringify(layout));
            assert.match(layout.reviewSummary.parentClass, /tt-requirement-workbench-meta/, JSON.stringify(layout));
            assert.equal(layout.reviewSummary.top >= layout.workbenchHeader.top - 1, true, JSON.stringify(layout));
            assert.equal(layout.reviewSummary.bottom <= layout.workbenchHeader.bottom + 1, true, JSON.stringify(layout));
            assert.equal(layout.reviewSummaryItems.every(item => (
                item.height <= 26 && item.scrollWidth <= item.clientWidth + 1
            )), true, JSON.stringify(layout));
            assert.equal(layout.sections.every((section, index, sections) => (
                index === 0 || section.top >= sections[index - 1].bottom - 1
            )), true, JSON.stringify(layout));
            assert.equal(layout.filter.scrollHeight <= layout.filter.clientHeight + 1, true, JSON.stringify(layout));
            assert.equal(layout.filter.overflowX === 'auto' && layout.filter.overflowY === 'hidden', true, JSON.stringify(layout));
            assert.equal(layout.filterButtons.every(button => (
                button.top >= layout.filter.top - 1 && button.bottom <= layout.filter.bottom + 1
            )), true, JSON.stringify(layout));
            assert.equal(layout.body.bottom <= layout.footer.top + 1, true, JSON.stringify(layout));
            assert.equal(layout.footer.bottom <= layout.viewport.height && layout.footer.bottom <= layout.dialog.bottom + 1, true, JSON.stringify(layout));
            assert.equal(layout.body.scrollHeight >= layout.body.clientHeight, true, JSON.stringify(layout));
        };

        await page.evaluate(() => document.body.classList.add('light-mode'));
        await page.waitForTimeout(250);
        await assertIntakeLayout();
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-intake-light.png') });
        await page.evaluate(() => document.body.classList.remove('light-mode'));
        await page.waitForTimeout(250);
        await assertIntakeLayout();
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-intake-dark.png') });

        await page.setViewportSize({ width: 390, height: 844 });
        await assertIntakeLayout();
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-intake-mobile.png') });
        await page.setViewportSize({ width: 1440, height: 900 });

        await page.fill('#tt-constraint-text-input', '语文尽量安排到上午');
        await clickByScript('[data-action="parse-constraints"]');

        await page.waitForSelector('.tt-requirement-workbench', { timeout: 30000 });

        assert.equal(await page.locator('[data-constraint-input-summary]').count(), 1);
        assert.equal(await page.locator('#tt-constraint-text-input').count(), 0);
        await clickByScript('[data-action="expand-constraint-input"]');
        await page.waitForSelector('#tt-constraint-text-input', { timeout: 10000 });
        assert.equal(await page.locator('#tt-constraint-text-input').inputValue(), '语文尽量安排到上午');
        await clickByScript('[data-action="parse-constraints"]');
        await page.waitForFunction(() => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            return document.querySelector('[data-constraint-input-summary]') && !planner?.state?.ruleReview?.parsing;
        }, { timeout: 30000 });
        const reparseResponse = page.waitForResponse(response => (
            response.url().includes('/api/tools/timetable/rules/parse')
            && response.request().method() === 'POST'
        ), { timeout: 30000 });
        await clickByScript('[data-action="reparse-constraint-input"]');
        await reparseResponse;
        await page.waitForFunction(() => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            return document.querySelector('[data-constraint-input-summary]') && !planner?.state?.ruleReview?.parsing;
        }, { timeout: 30000 });
        await page.setViewportSize({ width: 1560, height: 950 });
        await page.evaluate(() => document.body.classList.add('light-mode'));
        await page.waitForTimeout(500);
        await assertDesktopReviewLayout({ minReviewHeight: 220 });
        await assertHeaderActionTheme();
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-review-light.png') });
        await page.evaluate(() => document.body.classList.remove('light-mode'));
        await page.waitForTimeout(500);
        await assertDesktopReviewLayout({ minReviewHeight: 220 });
        await assertHeaderActionTheme();
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-review-desktop.png') });
        await page.setViewportSize({ width: 1440, height: 900 });
        await assertDesktopReviewLayout({ minReviewHeight: 220 });
        await page.setViewportSize({ width: 1280, height: 720 });
        await assertDesktopReviewLayout({ minReviewHeight: 120 });
        await page.setViewportSize({ width: 390, height: 844 });
        await assertMobileReviewLayout();
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-review-mobile.png') });
        await page.setViewportSize({ width: 1440, height: 900 });

        const reviewText = await recognizedText();
        assert.match(reviewText || '', /解析结果/);
        assert.match(reviewText || '', /已解析 1 条需求/);
        assert.match(reviewText || '', /共 1 条需求/);
        assert.match(reviewText || '', /可直接应用\s*0\s*项/);
        assert.match(reviewText || '', /需要确认\s*1\s*项/);
        assert.match(reviewText || '', /理解为 1 个子约束/);
        assert.match(reviewText || '', /缺少班级范围.*全校/);
        assert.match(reviewText || '', /语文/);
        assert.match(reviewText || '', /上午/);
        assert.deepEqual(await constraintFooterLabels(), ['取消']);
        assert.equal(await page.locator('.tt-constraint-dialog-actions .tt-btn--primary').count(), 0);
        assert.equal(await page.locator('[data-action="apply-constraints"]').count(), 0);

        await clearRecognizedConstraints();

        await page.fill('#tt-constraint-text-input', 'G7-1班语文尽量安排到上午');
        await clickByScript('[data-action="parse-constraints"]');
        await page.waitForSelector('.tt-requirement-workbench', { timeout: 30000 });
        const scopedReviewText = await recognizedText();
        assert.match(scopedReviewText || '', /可直接应用\s*1\s*项/);
        assert.match(scopedReviewText || '', /语文[｜|]\s*排课需求/);
        assert.deepEqual(await constraintFooterLabels(), ['取消', '应用需求 (1)']);

        await clearRecognizedConstraints();

        await clickByScript('[data-action="switch-constraint-mode"][data-mode="file"]');
        await page.locator('#tt-constraint-file-input').setInputFiles({
            name: 'smart-constraints.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('G7-1班物理尽量安排到上午', 'utf8'),
        });
        await page.waitForFunction(
            () => /smart-constraints\.txt/.test(document.querySelector('[data-constraint-dialog-overlay]')?.textContent || ''),
            { timeout: 10000 },
        );
        await clickByScript('[data-action="parse-constraints"]');
        await page.waitForSelector('.tt-requirement-workbench', { timeout: 30000 });

        const fileReviewText = await recognizedText();
        assert.match(fileReviewText || '', /解析结果/);
        assert.match(fileReviewText || '', /已解析 1 条需求/);
        assert.match(fileReviewText || '', /共 1 条需求/);
        assert.match(fileReviewText || '', /可直接应用\s*1\s*项/);
        assert.match(fileReviewText || '', /技术细节\s*查看子约束、机器规则和解析依据/);
        assert.match(fileReviewText || '', /落地结果/);
        assert.match(fileReviewText || '', /物理/);
        assert.match(fileReviewText || '', /上午/);
        assert.equal(dialogs.some(item => item.message === '请选择文件'), false);

        await clearRecognizedConstraints();

        const complete137Project = createCompleteNaturalLanguage137Project();
        await page.evaluate(async project => {
            const bootstrapResponse = await fetch('/api/tools/timetable/bootstrap');
            const bootstrapPayload = await bootstrapResponse.json();
            const saveResponse = await fetch('/api/tools/timetable/project', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...project,
                    version: bootstrapPayload.data.project.version,
                }),
            });
            const savePayload = await saveResponse.json();
            if (!saveResponse.ok || !savePayload.success) {
                throw new Error(savePayload.error || 'complete 137 project save failed');
            }
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            if (!planner) throw new Error('active timetable planner instance is unavailable');
            planner.applyProject(savePayload.data.project);
            planner.openConstraintDialog();
        }, complete137Project);

        await clickByScript('[data-action="switch-constraint-mode"][data-mode="file"]');
        await page.locator('#tt-constraint-file-input').setInputFiles({
            name: 'AI排课约束建议.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            buffer: buildConstraintWorkbook([
                ['约束内容'],
                ['G7-1班英语尽量安排到上午'],
            ]),
        });
        await page.waitForFunction(
            () => /AI排课约束建议\.xlsx/.test(document.querySelector('[data-constraint-dialog-overlay]')?.textContent || ''),
            { timeout: 10000 },
        );
        await clickByScript('[data-action="parse-constraints"]');
        await page.waitForSelector('.tt-requirement-workbench', { timeout: 30000 });

        const xlsxReviewText = await recognizedText();
        assert.match(xlsxReviewText || '', /解析结果/);
        assert.match(xlsxReviewText || '', /已解析 1 条需求/);
        assert.match(xlsxReviewText || '', /共 1 条需求/);
        assert.match(xlsxReviewText || '', /可直接应用\s*1\s*项/);
        assert.match(xlsxReviewText || '', /技术细节\s*查看子约束、机器规则和解析依据/);
        assert.match(xlsxReviewText || '', /落地结果/);
        assert.match(xlsxReviewText || '', /英语/);
        assert.match(xlsxReviewText || '', /上午/);
        assert.equal(dialogs.some(item => /Unexpected token|<!DOCTYPE/i.test(item.message)), false);

        await clearRecognizedConstraints();

        await clickByScript('[data-action="switch-constraint-mode"][data-mode="file"]');
        await page.locator('#tt-constraint-file-input').setInputFiles({
            name: 'timetable-natural-language-137.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            buffer: await readFile(new URL('../真实学校排课约束需求.xlsx', import.meta.url)),
        });
        await clickByScript('[data-action="parse-constraints"]');
        await page.waitForSelector('.tt-requirement-workbench', { timeout: 30000 });
        await clickByScript('[data-action="filter-requirements"][data-requirement-filter="all"]');
        await page.waitForFunction(
            () => document.querySelectorAll('.tt-requirement-row[data-requirement-id]').length === 137,
            { timeout: 30000 },
        );
        await page.setViewportSize({ width: 1560, height: 950 });
        await page.evaluate(() => document.body.classList.add('light-mode'));
        await page.waitForTimeout(500);
        await assertDesktopReviewLayout({ minReviewHeight: 220 });
        await assertHeaderActionTheme();
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-review-137-light.png') });
        await page.evaluate(() => document.body.classList.remove('light-mode'));
        await page.setViewportSize({ width: 1440, height: 900 });

        const realReviewText = await recognizedText();
        assert.match(realReviewText || '', /已解析 137 条需求/);
        assert.match(realReviewText || '', /可直接应用\s*131\s*项/);
        assert.match(realReviewText || '', /需要确认\s*6\s*项/);
        assert.doesNotMatch(realReviewText || '', /\b(?:unsupported|need_review|needs_review|schedule_request)\b/i);
        const realRequirementCards = page.locator('.tt-requirement-row[data-requirement-id]');
        assert.equal(await realRequirementCards.count(), 137);
        const sourceIds = await realRequirementCards.evaluateAll(nodes => nodes.map(node => node.dataset.requirementId));
        assert.equal(new Set(sourceIds).size, 137);
        const sourceTitles = await realRequirementCards.evaluateAll(nodes => nodes.map(node => node.getAttribute('title') || ''));
        const sourceTitleCounts = new Map();
        sourceTitles.forEach(title => sourceTitleCounts.set(title, (sourceTitleCounts.get(title) || 0) + 1));
        realConstraintFixture.forEach(item => {
            assert.equal(
                sourceTitleCounts.get(item.rawText),
                1,
                `真实原文必须且只能对应一张一级卡片：${item.rawText}`,
            );
        });
        const selectionAnchor = await page.evaluate(() => {
            const list = document.querySelector('.tt-requirement-table-body');
            if (!list) throw new Error('requirement list is unavailable');
            const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
            list.scrollTop = Math.round(maxScrollTop * 0.55);
            const listRect = list.getBoundingClientRect();
            const row = [...list.querySelectorAll('.tt-requirement-row[data-requirement-id]')]
                .find(node => {
                    const rect = node.getBoundingClientRect();
                    return node.getAttribute('aria-pressed') !== 'true'
                        && rect.top >= listRect.top + 4
                        && rect.bottom <= listRect.bottom - 4;
                });
            if (!row) throw new Error('no visible requirement row is available for scroll retention');
            return {
                requirementId: row.dataset.requirementId,
                scrollTop: list.scrollTop,
            };
        });
        assert.ok(selectionAnchor.scrollTop > 0, JSON.stringify(selectionAnchor));
        await page.evaluate(requirementId => {
            const row = [...document.querySelectorAll('.tt-requirement-row[data-requirement-id]')]
                .find(node => node.dataset.requirementId === requirementId);
            row?.click();
        }, selectionAnchor.requirementId);
        await page.waitForFunction(requirementId => {
            const row = [...document.querySelectorAll('.tt-requirement-row[data-requirement-id]')]
                .find(node => node.dataset.requirementId === requirementId);
            const detail = document.querySelector('.tt-requirement-detail[data-requirement-detail-id]');
            return row?.getAttribute('aria-pressed') === 'true'
                && detail?.dataset.requirementDetailId === requirementId;
        }, selectionAnchor.requirementId);
        const selectionResult = await page.evaluate(() => {
            const list = document.querySelector('.tt-requirement-table-body');
            const detail = document.querySelector('.tt-requirement-detail[data-requirement-detail-id]');
            return {
                listScrollTop: list?.scrollTop ?? -1,
                detailScrollTop: detail?.scrollTop ?? -1,
            };
        });
        assert.equal(
            Math.abs(selectionResult.listScrollTop - selectionAnchor.scrollTop) <= 1,
            true,
            JSON.stringify({ selectionAnchor, selectionResult }),
        );
        assert.equal(selectionResult.detailScrollTop, 0, JSON.stringify(selectionResult));
        await clickByScript('[data-action="filter-requirements"][data-requirement-filter="review"]');
        assert.equal(await page.locator('.tt-requirement-row[data-requirement-id]').count(), 6);
        await clickByScript('[data-action="filter-requirements"][data-requirement-filter="rule"]');
        assert.equal(await page.locator('.tt-requirement-row[data-requirement-id]').count(), 131);

        const multiClauseCard = page.locator(
            '.tt-requirement-row[data-requirement-id][title*="地理和生物尽量隔天分布"]',
        );
        assert.equal(await multiClauseCard.count(), 1);
        await multiClauseCard.click();
        const selectedDetail = page.locator('.tt-requirement-detail[data-requirement-detail-id]');
        await selectedDetail.waitFor({ state: 'visible', timeout: 10000 });
        const technicalToggle = selectedDetail.locator('[data-action="toggle-technical-details"]');
        if (await technicalToggle.getAttribute('aria-expanded') !== 'true') {
            await technicalToggle.click();
        }
        assert.ok(await selectedDetail.locator('.tt-requirement-clause-item').count() > 1);
        assert.match(await selectedDetail.textContent() || '', /理解为 [2-9]\d* 个子约束/);
        assert.match(await selectedDetail.textContent() || '', /执行可执行/);
        assert.doesNotMatch(await selectedDetail.textContent() || '', /当前版本只能预览这类建议/);
        await clickByScript('[data-action="filter-requirements"][data-requirement-filter="all"]');
        await assertDesktopReviewLayout({ minReviewHeight: 220 });
        await assertDesktopIndependentScrolling();

        await page.evaluate(() => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            if (!planner) throw new Error("active timetable planner instance is unavailable");
            planner.state.ruleReview.systemSupplements = [{
                supplementId: 'smoke-system-supplement',
                reason: '同一位教师同一时间只能上一节课。',
                requirement: {
                    id: 'smoke-system-requirement',
                    requirementId: 'smoke-system-requirement',
                    intent: 'teacher_conflict',
                    status: 'handled',
                    applyTo: 'handled',
                    object: { kind: 'global', name: '全校教师' },
                    source: { rawText: '同一位教师同一时间只能上一节课。' },
                },
            }];
            planner.state.ruleReview.statistics = {
                ...(planner.state.ruleReview.statistics || {}),
                systemSupplementCount: 1,
            };
            planner.state.constraintDialog.systemGroupCollapsed = true;
            planner.render();
        });
        await page.waitForSelector('.tt-system-requirement-toggle', { timeout: 10000 });
        assert.match(await recognizedText() || '', /系统已自动处理\s*1\s*项/);
        assert.match(await page.locator('.tt-system-requirement-toggle').textContent() || '', /系统补充需求\s*1[\s\S]*默认规则/);
        assert.equal(await page.locator('[data-requirement-id="smoke-system-supplement"]').count(), 0);
        await clickByScript('[data-action="toggle-system-group"]');
        await page.waitForSelector('[data-requirement-id="smoke-system-supplement"]', { timeout: 10000 });
        assert.equal(await page.locator('[data-requirement-id="smoke-system-supplement"]').count(), 1);

        await clearRecognizedConstraints();

        await clickByScript('.tt-dialog-header [data-action="close-constraint-dialog"]');
        await page.waitForFunction(() => !document.querySelector('[data-constraint-dialog-overlay]'));
        await page.evaluate(() => window.ICeCream?.appLauncher?.currentToolInstance?.openRosterImport('file'));
        await page.waitForSelector('#tt-roster-import-dialog', { timeout: 10000 });
        await page.locator('#tt-roster-import-file').setInputFiles(REAL_ROSTER_FILE);
        await page.click('[data-roster-import-submit="file"]');
        await page.waitForFunction(() => (
            document.querySelectorAll('[data-roster-review-row]').length === 360
        ), { timeout: 30000 });
        await page.click('#tt-confirm-roster-import');
        await page.waitForFunction(() => !document.querySelector('#tt-roster-import-dialog'), { timeout: 30000 });
        await page.click('#tt-open-rule-review');
        await page.waitForSelector('[data-constraint-dialog-overlay]', { timeout: 10000 });

        await clickByScript('[data-action="switch-constraint-mode"][data-mode="manual"]');
        const assertManualFormLayout = async (expectedColumns, expectedChipColor) => {
            const layout = await page.evaluate(() => {
                const dialog = document.querySelector('.tt-constraint-dialog').getBoundingClientRect();
                const form = document.querySelector('.tt-constraint-rule-form').getBoundingClientRect();
                const fields = document.querySelector('.tt-constraint-rule-main-fields');
                const slotGrid = document.querySelector('.tt-constraint-rule-slot-grid');
                const slotRect = slotGrid.getBoundingClientRect();
                const firstChipInput = document.querySelector('.tt-constraint-rule-slot-chip input');
                const firstChipStyle = getComputedStyle(firstChipInput.nextElementSibling);
                return {
                    viewportWidth: window.innerWidth,
                    documentWidth: document.documentElement.scrollWidth,
                    dialog: { left: dialog.left, right: dialog.right },
                    form: { left: form.left, right: form.right },
                    fieldColumns: getComputedStyle(fields).gridTemplateColumns.split(/\s+/).filter(Boolean).length,
                    slot: {
                        left: slotRect.left,
                        right: slotRect.right,
                        clientWidth: slotGrid.clientWidth,
                        scrollWidth: slotGrid.scrollWidth,
                        overflowX: getComputedStyle(slotGrid).overflowX,
                    },
                    chip: {
                        checked: firstChipInput.checked,
                        background: firstChipStyle.backgroundColor,
                        color: firstChipStyle.color,
                        opacity: firstChipStyle.opacity,
                    },
                };
            });
            assert.equal(layout.documentWidth <= layout.viewportWidth, true, JSON.stringify(layout));
            assert.equal(layout.form.left >= layout.dialog.left - 1 && layout.form.right <= layout.dialog.right + 1, true, JSON.stringify(layout));
            assert.equal(layout.slot.left >= layout.dialog.left - 1 && layout.slot.right <= layout.dialog.right + 1, true, JSON.stringify(layout));
            assert.equal(layout.slot.overflowX, 'auto', JSON.stringify(layout));
            assert.equal(layout.fieldColumns, expectedColumns, JSON.stringify(layout));
            assert.equal(layout.chip.checked, false, JSON.stringify(layout));
            assert.equal(layout.chip.opacity, '1', JSON.stringify(layout));
            assert.equal(layout.chip.color, expectedChipColor, JSON.stringify(layout));
        };

        await page.evaluate(() => document.body.classList.add('light-mode'));
        await page.waitForFunction(() => (
            getComputedStyle(document.querySelector('.tt-constraint-rule-slot-chip span')).color === 'rgb(15, 23, 42)'
        ));
        await assertManualFormLayout(3, 'rgb(15, 23, 42)');
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-manual-light.png') });
        await page.evaluate(() => document.body.classList.remove('light-mode'));
        await page.waitForFunction(() => (
            getComputedStyle(document.querySelector('.tt-constraint-rule-slot-chip span')).color === 'rgb(241, 245, 249)'
        ));
        await assertManualFormLayout(3, 'rgb(241, 245, 249)');
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-manual-dark.png') });
        await page.setViewportSize({ width: 390, height: 844 });
        await assertManualFormLayout(1, 'rgb(241, 245, 249)');
        await page.locator('[data-constraint-rule-help-toggle]').click();
        await page.waitForFunction(() => {
            const help = document.querySelector('[data-constraint-rule-type-help]');
            return help && !help.hidden && help.textContent?.includes('所选教师在勾选节次不得安排课程');
        });
        const mobileRuleTypeHelp = await page.evaluate(() => {
            const help = document.querySelector('[data-constraint-rule-type-help]').getBoundingClientRect();
            return {
                left: help.left,
                right: help.right,
                top: help.top,
                bottom: help.bottom,
                width: window.innerWidth,
                height: window.innerHeight,
            };
        });
        assert.equal(mobileRuleTypeHelp.left >= 0 && mobileRuleTypeHelp.right <= mobileRuleTypeHelp.width, true, JSON.stringify(mobileRuleTypeHelp));
        assert.equal(mobileRuleTypeHelp.top >= 0 && mobileRuleTypeHelp.bottom <= mobileRuleTypeHelp.height, true, JSON.stringify(mobileRuleTypeHelp));
        await page.locator('[data-constraint-rule-help-toggle]').press('Escape');
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-manual-mobile.png') });
        await page.setViewportSize({ width: 1440, height: 900 });

        const selectRuleType = async (prefix, type) => {
            await page.locator(`#${prefix}-type-trigger`).click();
            await page.locator(`#${prefix}-type-option-${type}`).click();
        };
        await page.locator('#tt-manual-rule-type-trigger').click();
        await page.locator('#tt-manual-rule-type-option-subject_preferred_periods').hover();
        await page.waitForFunction(() => {
            const help = document.querySelector('[data-constraint-rule-type-help]');
            return help && !help.hidden && help.textContent?.includes('所选课程尽量安排在勾选节次');
        });
        const ruleTypePopover = await page.evaluate(() => {
            const help = document.querySelector('[data-constraint-rule-type-help]').getBoundingClientRect();
            const list = document.querySelector('[data-constraint-rule-type-listbox]').getBoundingClientRect();
            const active = document.querySelector('[data-constraint-rule-type-option].is-active').getBoundingClientRect();
            return {
                help: { left: help.left, right: help.right, top: help.top, bottom: help.bottom },
                list: { left: list.left, right: list.right, top: list.top, bottom: list.bottom },
                active: { top: active.top, bottom: active.bottom },
                viewport: { width: window.innerWidth, height: window.innerHeight },
            };
        });
        assert.equal(ruleTypePopover.help.left >= 0 && ruleTypePopover.help.right <= ruleTypePopover.viewport.width, true, JSON.stringify(ruleTypePopover));
        assert.equal(ruleTypePopover.help.top >= 0 && ruleTypePopover.help.bottom <= ruleTypePopover.viewport.height, true, JSON.stringify(ruleTypePopover));
        assert.equal(ruleTypePopover.help.left >= ruleTypePopover.list.right || ruleTypePopover.help.right <= ruleTypePopover.list.left, true, JSON.stringify(ruleTypePopover));
        assert.equal(Math.abs(
            (ruleTypePopover.help.top + ruleTypePopover.help.bottom) / 2
            - (ruleTypePopover.active.top + ruleTypePopover.active.bottom) / 2,
        ) <= 1, true, JSON.stringify(ruleTypePopover));
        const visibleRuleTypeChecks = await page.locator('[data-constraint-rule-type-listbox] [data-lucide="check"], [data-constraint-rule-type-listbox] svg.lucide-check')
            .evaluateAll(icons => icons.filter(icon => getComputedStyle(icon).opacity === '1').length);
        assert.equal(visibleRuleTypeChecks, 1);
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-rule-type-help.png') });
        await page.locator('#tt-manual-rule-type-trigger').press('Escape');
        await page.locator('#tt-manual-rule-type-trigger').press('ArrowDown');
        await page.waitForFunction(() => {
            const help = document.querySelector('[data-constraint-rule-type-help]');
            return help && !help.hidden && help.textContent?.includes('所选班级在勾选节次不得安排任何课程');
        });
        await page.locator('#tt-manual-rule-type-trigger').press('Escape');
        await selectRuleType('tt-manual-rule', 'teacher_unavailable');
        const manualTeacher = await page.locator('#tt-manual-rule-target option').nth(1).evaluate(option => ({
            value: option.value,
            label: option.textContent?.trim() || '',
        }));
        assert.ok(manualTeacher.value.startsWith('teacher:'));
        await page.selectOption('#tt-manual-rule-target', manualTeacher.value);
        await page.check('[data-manual-rule-slot][value="1-1"]');
        await clickByScript('[data-action="add-manual-constraint"]');
        await page.waitForSelector('.tt-requirement-workbench', { timeout: 10000 });

        const manualReviewText = await recognizedText();
        assert.match(manualReviewText || '', /解析结果/);
        assert.match(manualReviewText || '', /已解析 1 条需求/);
        assert.match(manualReviewText || '', /共 1 条需求/);
        assert.match(manualReviewText || '', /可直接应用\s*1\s*项/);
        assert.match(manualReviewText || '', /技术细节\s*查看子约束、机器规则和解析依据/);
        assert.match(manualReviewText || '', /落地结果/);
        assert.match(manualReviewText || '', new RegExp(manualTeacher.label));
        assert.match(manualReviewText || '', /周一第1节/);

        await clickByScript('[data-action="expand-constraint-input"]');
        await page.waitForSelector('#tt-manual-rule-type-trigger', { timeout: 10000 });
        await selectRuleType('tt-manual-rule', 'subject_preferred_periods');
        const manualSubject = await page.locator('#tt-manual-rule-target option').nth(1).evaluate(option => ({
            value: option.value,
            label: option.textContent?.trim() || '',
        }));
        assert.ok(manualSubject.value.startsWith('subject:'));
        await page.selectOption('#tt-manual-rule-target', manualSubject.value);
        await page.waitForFunction(() => {
            const field = document.querySelector('#tt-manual-rule-scope-class');
            return field && !field.disabled && field.options.length > 1;
        });
        const manualScopeClass = await page.locator('#tt-manual-rule-scope-class option').nth(1).evaluate(option => ({
            value: option.value,
            label: option.textContent?.trim() || '',
        }));
        await page.selectOption('#tt-manual-rule-scope-class', manualScopeClass.value);
        await page.waitForFunction(() => !document.querySelector('#tt-manual-rule-scope-limit-teacher')?.disabled);
        await page.check('#tt-manual-rule-scope-limit-teacher');
        await page.waitForFunction(() => {
            const field = document.querySelector('#tt-manual-rule-scope-teacher');
            return field && !field.disabled && field.options.length > 1;
        });
        const manualScopeTeacher = await page.locator('#tt-manual-rule-scope-teacher option').nth(1).evaluate(option => ({
            value: option.value,
            label: option.textContent?.trim() || '',
        }));
        await page.selectOption('#tt-manual-rule-scope-teacher', manualScopeTeacher.value);
        await page.check('[data-manual-rule-slot][value="2-2"]');
        await clickByScript('[data-action="add-manual-constraint"]');

        await clickByScript('[data-action="expand-constraint-input"]');
        await page.waitForSelector('#tt-manual-rule-type-trigger', { timeout: 10000 });
        await selectRuleType('tt-manual-rule', 'teacher_daily_limit');
        await page.selectOption('#tt-manual-rule-target', manualTeacher.value);
        await page.fill('#tt-manual-rule-limit', '4');
        await clickByScript('[data-action="add-manual-constraint"]');
        assert.deepEqual(await constraintFooterLabels(), ['取消', '应用需求 (3)']);

        const teacherUnavailableRequirement = page.locator(
            '.tt-requirement-row[data-requirement-id]',
        ).filter({ hasText: /不可排/ }).first();
        await teacherUnavailableRequirement.click();
        await page.locator('[data-action="edit-constraint"]').first().click();
        await page.waitForSelector('#tt-edit-constraint-type-trigger', { timeout: 10000 });
        await page.locator('#tt-edit-constraint-type-trigger').click();
        await page.locator('#tt-edit-constraint-type-option-subject_avoid_periods').hover();
        await page.waitForFunction(() => {
            const help = document.querySelector('#tt-edit-constraint-type-help');
            return help && !help.hidden && help.textContent?.includes('所选课程尽量避开勾选节次');
        });
        await page.locator('#tt-edit-constraint-type-trigger').press('Escape');
        await selectRuleType('tt-edit-constraint', 'teacher_unavailable');
        await page.click('[data-action="save-edit-constraint"]');
        await page.waitForFunction(() => !document.querySelector('.tt-constraint-edit-modal'), null, { timeout: 10000 });

        await clickByScript('[data-action="apply-constraints"]');
        await page.waitForFunction(() => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            return planner && !planner.state?.ruleReview?.applying;
        }, { timeout: 10000 });
        const applyState = await page.evaluate(() => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            return {
                dialogOpen: Boolean(planner?.state?.constraintDialog?.open),
                applyErrors: planner?.state?.ruleReview?.applyErrors || [],
                draftRows: (planner?.state?.ruleReview?.draftRows || []).map(row => ({ id: row.id, type: row.type, status: row.status })),
                sourceRequirements: (planner?.state?.ruleReview?.sourceRequirements || []).map(source => ({
                    sourceId: source.sourceId,
                    status: source.status,
                    reviewStatus: source.reviewStatus,
                    executionStatus: source.executionStatus,
                })),
            };
        });
        assert.equal(applyState.dialogOpen, false, JSON.stringify({ applyState, dialogs }, null, 2));
        assert.ok(dialogs.some(item => /已写入 1 条硬规则、2 条软规则，更新 0 个任课计划。共 3 条已生效。/.test(item.message)));
        const persistedManualRules = await page.evaluate(({ teacherValue, subjectValue, classValue, scopeTeacherValue }) => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            const teacherId = teacherValue.split(':').slice(1).join(':');
            const subjectId = subjectValue.split(':').slice(1).join(':');
            const subjectRule = (planner?.state?.project?.rules?.advancedRules || []).find(rule => (
                rule.type === 'subject.preferred_periods'
                && rule.target?.matchedIds?.includes(subjectId)
            ));
            return {
                teacherId,
                subjectId,
                unavailableSlots: planner?.state?.project?.rules?.hardRules?.teacherUnavailable?.[teacherId] || [],
                subjectRule,
                classId: classValue,
                scopeTeacherId: scopeTeacherValue,
                dailyLimit: planner?.state?.project?.rules?.softRules?.teacherLimits?.[teacherId]?.daily ?? null,
            };
        }, {
            teacherValue: manualTeacher.value,
            subjectValue: manualSubject.value,
            classValue: manualScopeClass.value,
            scopeTeacherValue: manualScopeTeacher.value,
        });
        assert.ok(persistedManualRules.unavailableSlots.includes('1-1'));
        assert.ok(persistedManualRules.subjectRule?.parameters?.slots?.includes('2-2'));
        assert.deepEqual(persistedManualRules.subjectRule?.parameters?.classIds, [persistedManualRules.classId]);
        assert.deepEqual(persistedManualRules.subjectRule?.parameters?.teacherIds, [persistedManualRules.scopeTeacherId]);
        assert.equal(persistedManualRules.dailyLimit, 4);

        console.log('timetable rule review smoke passed');
    });
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
