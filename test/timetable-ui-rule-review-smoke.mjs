import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import AdmZip from 'adm-zip';

import { withOpenedTimetablePage } from './timetable-ui-smoke-helpers.mjs';
import { createCompleteNaturalLanguage137Project } from './fixtures/timetable-natural-language-137-project.js';
import {
    TIMETABLE_CONSTRAINT_WORKBOOK_PATH,
    TIMETABLE_ROSTER_WORKBOOK_PATH,
} from './fixtures/timetable-workbook-paths.js';

const ARTIFACT_DIR = path.resolve('artifacts');
const REAL_ROSTER_FILE = TIMETABLE_ROSTER_WORKBOOK_PATH;

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

        const assertCompactConstraintSidebar = async ({ menuOpen = false } = {}) => {
            const layout = await page.evaluate(() => {
                const sidebarElement = document.querySelector('.tt-sidebar');
                const shellElement = document.querySelector('.tt-smart-helper-entry-shell');
                const entryElement = document.querySelector('#tt-open-rule-review');
                const triggerElement = document.querySelector('[data-action="toggle-constraint-sidebar-menu"]');
                const menuElement = document.querySelector('.tt-smart-helper-menu');
                const sidebar = sidebarElement.getBoundingClientRect();
                const shell = shellElement.getBoundingClientRect();
                const entry = entryElement.getBoundingClientRect();
                const trigger = triggerElement.getBoundingClientRect();
                const menu = menuElement?.getBoundingClientRect() || null;
                return {
                    viewport: { width: window.innerWidth, height: window.innerHeight },
                    documentWidth: document.documentElement.scrollWidth,
                    sidebar: { left: sidebar.left, right: sidebar.right },
                    shell: { left: shell.left, right: shell.right, height: shell.height },
                    entry: {
                        left: entry.left,
                        right: entry.right,
                        height: entry.height,
                        scrollWidth: entryElement.scrollWidth,
                        clientWidth: entryElement.clientWidth,
                    },
                    trigger: { left: trigger.left, right: trigger.right, width: trigger.width },
                    menu: menu ? { left: menu.left, right: menu.right, top: menu.top, bottom: menu.bottom } : null,
                    menuOpen: triggerElement.getAttribute('aria-expanded'),
                    forbiddenCount: document.querySelectorAll('.tt-smart-helper-flow, .tt-smart-helper-metrics, .tt-constraint-agent-panel, .tt-constraint-agent-mini-card').length,
                    internalActionText: /rules_patch|rule_patch|模型动作|暂停/.test(sidebarElement.textContent || ''),
                };
            });
            assert.equal(layout.documentWidth <= layout.viewport.width, true, JSON.stringify(layout));
            assert.equal(layout.shell.left >= layout.sidebar.left && layout.shell.right <= layout.sidebar.right, true, JSON.stringify(layout));
            assert.equal(layout.entry.left >= layout.shell.left && layout.entry.right <= layout.trigger.left, true, JSON.stringify(layout));
            assert.equal(layout.entry.height <= 76, true, JSON.stringify(layout));
            assert.equal(layout.entry.scrollWidth <= layout.entry.clientWidth + 1, true, JSON.stringify(layout));
            assert.equal(layout.trigger.width <= 38 && layout.trigger.right <= layout.shell.right + 1, true, JSON.stringify(layout));
            assert.equal(layout.forbiddenCount, 0, JSON.stringify(layout));
            assert.equal(layout.internalActionText, false, JSON.stringify(layout));
            assert.equal(layout.menuOpen, menuOpen ? 'true' : 'false', JSON.stringify(layout));
            if (menuOpen) {
                assert.ok(layout.menu, JSON.stringify(layout));
                assert.equal(layout.menu.left >= 0 && layout.menu.right <= layout.viewport.width, true, JSON.stringify(layout));
                assert.equal(layout.menu.top >= 0 && layout.menu.bottom <= layout.viewport.height, true, JSON.stringify(layout));
            }
        };

        const assertAgentDialogLayout = async ({ mobile = false, review = false } = {}) => {
            const layout = await page.evaluate(() => {
                const dialogElement = document.querySelector('.tt-constraint-dialog--agent');
                const bodyElement = document.querySelector('.tt-constraint-dialog-body--agent');
                const panelElement = document.querySelector('.tt-constraint-agent-panel');
                const threadElement = document.querySelector('.tt-constraint-agent-thread');
                const inputElement = document.querySelector('#tt-constraint-agent-message');
                const workbenchElement = document.querySelector('.tt-requirement-workbench');
                const footerElement = document.querySelector('.tt-constraint-agent-footer');
                const rect = element => {
                    const value = element?.getBoundingClientRect();
                    return value ? { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height } : null;
                };
                return {
                    viewport: { width: window.innerWidth, height: window.innerHeight },
                    documentWidth: document.documentElement.scrollWidth,
                    dialog: rect(dialogElement),
                    body: rect(bodyElement),
                    panel: rect(panelElement),
                    thread: rect(threadElement),
                    input: rect(inputElement),
                    workbench: rect(workbenchElement),
                    footer: rect(footerElement),
                    bodyOverflowY: getComputedStyle(bodyElement).overflowY,
                    threadOverflowY: threadElement ? getComputedStyle(threadElement).overflowY : '',
                    standardApplyCount: document.querySelectorAll('[data-action="apply-constraints"]').length,
                    primaryCount: footerElement?.querySelectorAll('.tt-btn--primary').length || 0,
                    miniCardCount: document.querySelectorAll('.tt-constraint-agent-mini-card').length,
                };
            });
            assert.equal(layout.documentWidth <= layout.viewport.width, true, JSON.stringify(layout));
            assert.ok(layout.dialog && layout.body && layout.panel && layout.footer, JSON.stringify(layout));
            assert.equal(layout.dialog.left >= (mobile ? -1 : 23) && layout.dialog.right <= layout.viewport.width - (mobile ? -1 : 23), true, JSON.stringify(layout));
            assert.equal(layout.dialog.bottom <= layout.viewport.height + 1, true, JSON.stringify(layout));
            const expectedMaxHeight = mobile
                ? layout.viewport.height - 20
                : Math.min(820, layout.viewport.height - 48);
            assert.equal(layout.dialog.height <= expectedMaxHeight + 2, true, JSON.stringify(layout));
            assert.equal(layout.body.bottom <= layout.footer.top + 1, true, JSON.stringify(layout));
            assert.equal(layout.panel.top >= layout.body.top - 1, true, JSON.stringify(layout));
            assert.equal(layout.standardApplyCount, 0, JSON.stringify(layout));
            assert.equal(layout.primaryCount, 1, JSON.stringify(layout));
            assert.equal(layout.miniCardCount, 0, JSON.stringify(layout));
            if (review) {
                assert.ok(layout.workbench, JSON.stringify(layout));
                assert.equal(layout.dialog.width <= Math.min(1120, layout.viewport.width - (mobile ? 0 : 48)) + 2, true, JSON.stringify(layout));
                if (!mobile && layout.viewport.width >= 1200) {
                    assert.equal(layout.dialog.width >= 1118, true, JSON.stringify(layout));
                    assert.equal(layout.panel.bottom <= layout.workbench.top + 1, true, JSON.stringify(layout));
                    assert.equal(layout.workbench.bottom <= layout.body.bottom + 1, true, JSON.stringify(layout));
                }
            } else {
                assert.equal(layout.dialog.width <= Math.min(960, layout.viewport.width - (mobile ? 0 : 48)) + 2, true, JSON.stringify(layout));
                assert.ok(layout.thread && layout.input, JSON.stringify(layout));
                if (!mobile) {
                    assert.equal(layout.dialog.width >= Math.min(958, layout.viewport.width - 50), true, JSON.stringify(layout));
                    assert.equal(layout.threadOverflowY, 'auto', JSON.stringify(layout));
                    assert.equal(layout.panel.bottom <= layout.body.bottom + 1, true, JSON.stringify(layout));
                } else {
                    assert.equal(['auto', 'scroll'].includes(layout.bodyOverflowY), true, JSON.stringify(layout));
                }
            }
        };

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

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.evaluate(() => document.body.classList.add('light-mode'));
        await assertCompactConstraintSidebar();
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-sidebar-light.png') });
        await page.evaluate(() => document.body.classList.remove('light-mode'));
        await assertCompactConstraintSidebar();
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-sidebar-dark.png') });

        await page.setViewportSize({ width: 390, height: 844 });
        await page.click('[data-action="toggle-constraint-sidebar-menu"]');
        await page.waitForSelector('.tt-smart-helper-menu');
        await assertCompactConstraintSidebar({ menuOpen: true });
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-sidebar-mobile.png') });
        await page.click('[data-action="toggle-constraint-sidebar-menu"]');

        await page.setViewportSize({ width: 1280, height: 720 });
        await page.evaluate(() => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            if (!planner) throw new Error('active timetable planner instance is unavailable');
            planner.state.workflowOpenSections = ['data', 'rules', 'solve'];
            planner.render();
        });
        await page.waitForFunction(() => ['data', 'solve'].every(section => (
            document.querySelector(`[data-tt-section-toggle="${section}"]`)?.getAttribute('aria-expanded') === 'true'
        )));
        const sidebarScrollAnchor = await page.evaluate(() => {
            const sidebar = document.querySelector('.tt-sidebar');
            const maxScrollTop = Math.max(0, sidebar.scrollHeight - sidebar.clientHeight);
            sidebar.scrollTop = Math.round(maxScrollTop * 0.6);
            return sidebar.scrollTop;
        });
        assert.ok(sidebarScrollAnchor > 0, JSON.stringify({ sidebarScrollAnchor }));
        await clickByScript('#tt-open-rule-review');
        await page.waitForSelector('[data-constraint-dialog-overlay]', { timeout: 10000 });
        await page.click('[data-action="close-constraint-dialog"]');
        await page.waitForFunction(() => !document.querySelector('[data-constraint-dialog-overlay]'));
        const restoredSidebarScroll = await page.evaluate(() => document.querySelector('.tt-sidebar')?.scrollTop ?? -1);
        assert.equal(Math.abs(restoredSidebarScroll - sidebarScrollAnchor) <= 1, true, JSON.stringify({ sidebarScrollAnchor, restoredSidebarScroll }));

        await page.setViewportSize({ width: 1440, height: 900 });
        await clickByScript('#tt-open-rule-review');
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
            await page.waitForFunction(() => {
                const normalizeColor = value => {
                    const probe = document.createElement('span');
                    probe.style.color = value;
                    document.body.appendChild(probe);
                    const color = getComputedStyle(probe).color;
                    probe.remove();
                    return color;
                };
                const channels = value => (String(value || '').match(/[\d.]+/g) || []).map(Number);
                const withinDelta = (actual, expected) => {
                    const actualChannels = channels(actual);
                    const expectedChannels = channels(expected);
                    return Math.max(...expectedChannels.map((value, index) => Math.abs(value - (actualChannels[index] ?? value)))) <= 8;
                };
                const workbenchStyle = getComputedStyle(document.querySelector('.tt-workbench'));
                const aiButton = document.querySelector('[data-action="start-ai-chat"]');
                const closeButton = document.querySelector('[data-action="close-constraint-dialog"]');
                return (!aiButton || withinDelta(getComputedStyle(aiButton).color, normalizeColor(workbenchStyle.getPropertyValue('--tt-text'))))
                    && withinDelta(getComputedStyle(closeButton).backgroundColor, normalizeColor(workbenchStyle.getPropertyValue('--tt-bg-soft')));
            }, null, { timeout: 5000 });
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
            if (theme.aiColor) assert.equal(maxColorDelta(theme.aiColor, theme.expectedText) <= 8, true, JSON.stringify(theme));
            assert.equal(maxColorDelta(theme.closeBackground, theme.expectedSoft) <= 8, true, JSON.stringify(theme));
        };

        const assertConstraintEditorLayout = async ({ mobile = false, requireBodyScroll = false } = {}) => {
            const layout = await page.evaluate(() => {
                const modal = document.querySelector('.tt-constraint-edit-modal');
                const header = modal?.querySelector('.tt-dialog-header');
                const body = modal?.querySelector('.tt-constraint-edit-body');
                const footer = modal?.querySelector('.tt-dialog-actions');
                const slotGrid = modal?.querySelector('.tt-constraint-rule-slot-grid');
                const headerCopy = header?.firstElementChild;
                const closeButton = header?.querySelector('.tt-constraint-edit-close');
                const actionButtons = [...footer?.querySelectorAll('button') || []];
                if (!modal || !header || !body || !footer) throw new Error('constraint editor layout is unavailable');
                const rect = element => {
                    const value = element.getBoundingClientRect();
                    return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
                };
                return {
                    viewport: { width: window.innerWidth, height: window.innerHeight },
                    documentWidth: document.documentElement.scrollWidth,
                    modal: rect(modal),
                    header: rect(header),
                    headerCopy: rect(headerCopy),
                    closeButton: rect(closeButton),
                    body: {
                        ...rect(body),
                        clientHeight: body.clientHeight,
                        scrollHeight: body.scrollHeight,
                        overflowY: getComputedStyle(body).overflowY,
                    },
                    footer: rect(footer),
                    actionButtons: actionButtons.map(rect),
                    modalChrome: {
                        overflow: getComputedStyle(modal).overflow,
                        radii: [
                            getComputedStyle(modal).borderTopLeftRadius,
                            getComputedStyle(modal).borderTopRightRadius,
                            getComputedStyle(modal).borderBottomRightRadius,
                            getComputedStyle(modal).borderBottomLeftRadius,
                        ],
                    },
                    slotGrid: slotGrid ? {
                        ...rect(slotGrid),
                        clientWidth: slotGrid.clientWidth,
                        scrollWidth: slotGrid.scrollWidth,
                        overflowX: getComputedStyle(slotGrid).overflowX,
                    } : null,
                };
            });
            assert.equal(layout.documentWidth <= layout.viewport.width, true, JSON.stringify(layout));
            assert.equal(layout.modal.left >= -1 && layout.modal.right <= layout.viewport.width + 1, true, JSON.stringify(layout));
            assert.equal(layout.modal.top >= -1 && layout.modal.bottom <= layout.viewport.height + 1, true, JSON.stringify(layout));
            assert.equal(layout.header.bottom <= layout.body.top + 1, true, JSON.stringify(layout));
            assert.equal(layout.body.bottom <= layout.footer.top + 1, true, JSON.stringify(layout));
            assert.equal(layout.body.overflowY, 'auto', JSON.stringify(layout));
            assert.equal(layout.modalChrome.overflow, 'hidden', JSON.stringify(layout));
            const modalRadii = layout.modalChrome.radii.map(Number.parseFloat);
            assert.equal(
                mobile
                    ? modalRadii.slice(0, 2).every(value => value >= 8) && modalRadii.slice(2).every(value => value === 0)
                    : modalRadii.every(value => value >= 8),
                true,
                JSON.stringify(layout),
            );
            assert.equal(layout.headerCopy.left >= layout.modal.left + 15, true, JSON.stringify(layout));
            assert.equal(layout.closeButton.right <= layout.modal.right - 15, true, JSON.stringify(layout));
            assert.equal(layout.closeButton.width <= 33 && layout.closeButton.height <= 33, true, JSON.stringify(layout));
            assert.equal(layout.actionButtons.every(button => button.right <= layout.modal.right - 15), true, JSON.stringify(layout));
            assert.equal(layout.actionButtons.every(button => button.bottom <= layout.modal.bottom - 15), true, JSON.stringify(layout));
            if (mobile) {
                assert.equal(layout.modal.width <= layout.viewport.width + 1, true, JSON.stringify(layout));
                assert.equal(layout.modal.bottom >= layout.viewport.height - 11, true, JSON.stringify(layout));
                if (layout.slotGrid) {
                    assert.equal(layout.slotGrid.left >= layout.modal.left - 1 && layout.slotGrid.right <= layout.modal.right + 1, true, JSON.stringify(layout));
                    assert.equal(layout.slotGrid.overflowX, 'auto', JSON.stringify(layout));
                    assert.equal(layout.slotGrid.scrollWidth >= layout.slotGrid.clientWidth, true, JSON.stringify(layout));
                }
            } else {
                assert.equal(layout.modal.width <= 721 && layout.modal.height <= 761, true, JSON.stringify(layout));
            }
            if (requireBodyScroll) {
                assert.equal(layout.body.scrollHeight > layout.body.clientHeight, true, JSON.stringify(layout));
            }
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

        await clickByScript('[data-action="switch-constraint-mode"][data-mode="agent"]');
        await page.waitForSelector('.tt-constraint-agent-panel.is-expanded');
        assert.deepEqual(await constraintFooterLabels(), ['取消', '发送']);
        await page.setViewportSize({ width: 1560, height: 950 });
        await page.evaluate(() => document.body.classList.add('light-mode'));
        await page.waitForTimeout(250);
        await assertAgentDialogLayout();
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-agent-light.png') });
        await page.evaluate(() => document.body.classList.remove('light-mode'));
        await page.setViewportSize({ width: 1440, height: 900 });
        await assertAgentDialogLayout();
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-agent-dark.png') });
        await page.setViewportSize({ width: 1280, height: 720 });
        await assertAgentDialogLayout();
        await page.setViewportSize({ width: 390, height: 844 });
        await assertAgentDialogLayout({ mobile: true });
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-agent-mobile.png') });
        await page.setViewportSize({ width: 1440, height: 900 });
        await clickByScript('[data-action="switch-constraint-mode"][data-mode="text"]');
        await page.waitForSelector('#tt-constraint-text-input');

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

        await page.evaluate(() => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            if (!planner) throw new Error('active timetable planner instance is unavailable');
            planner.state.ruleReview.inputMode = 'agent';
            planner.state.ruleReview.mode = 'agent';
            planner.state.constraintAgent = {
                sessionId: 'smoke-agent-session',
                stage: 'CONFIRM',
                messages: [
                    { role: 'user', content: '语文尽量安排到上午' },
                    { role: 'assistant', content: '已生成可复核的理解结果。' },
                ],
                questions: [],
                statusLine: '[已理解 1 · 待澄清 0 · 待确认 1]',
                confirmationToken: 'smoke-confirmation-token',
                highRiskToken: '',
                confirmed: false,
                highRiskConfirmed: false,
                loading: false,
                error: '',
                input: '',
            };
            planner.state.constraintDialog = {
                ...(planner.state.constraintDialog || {}),
                open: true,
                agentConversationExpanded: false,
            };
            planner.render();
        });
        await page.waitForSelector('.tt-constraint-dialog--agent.tt-constraint-dialog--semantic-review .tt-requirement-workbench');
        assert.deepEqual(await constraintFooterLabels(), ['取消', '确认理解结果']);
        assert.equal(await page.locator('.tt-constraint-agent-panel.is-collapsed').count(), 1);
        assert.equal(await page.locator('[data-action="apply-constraints"], .tt-constraint-agent-mini-card').count(), 0);
        await page.setViewportSize({ width: 1560, height: 950 });
        await page.evaluate(() => document.body.classList.add('light-mode'));
        await page.waitForTimeout(250);
        await assertAgentDialogLayout({ review: true });
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-agent-review-light.png') });
        await page.evaluate(() => document.body.classList.remove('light-mode'));
        await page.setViewportSize({ width: 1440, height: 900 });
        await assertAgentDialogLayout({ review: true });
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-agent-review-dark.png') });
        await page.setViewportSize({ width: 1280, height: 720 });
        await assertAgentDialogLayout({ review: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await assertAgentDialogLayout({ mobile: true, review: true });
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-agent-review-mobile.png') });
        await page.setViewportSize({ width: 1440, height: 900 });
        await clickByScript('[data-action="switch-constraint-mode"][data-mode="text"]');
        await page.waitForFunction(() => !document.querySelector('.tt-constraint-dialog--agent'));

        const reviewText = await recognizedText();
        assert.match(reviewText || '', /解析结果/);
        assert.match(reviewText || '', /已解析 1 条需求/);
        assert.match(reviewText || '', /共 1 条需求/);
        assert.match(reviewText || '', /可直接应用\s*1\s*项/);
        assert.match(reviewText || '', /需要确认\s*0\s*项/);
        assert.match(reviewText || '', /语文/);
        assert.match(reviewText || '', /上午/);
        const initialTechnicalToggle = page.locator('.tt-requirement-detail [data-action="toggle-technical-details"]');
        if (await initialTechnicalToggle.getAttribute('aria-expanded') !== 'true') {
            await initialTechnicalToggle.click();
        }
        assert.match(await page.locator('.tt-requirement-detail').textContent() || '', /理解为 1 个子约束/);
        assert.deepEqual(await constraintFooterLabels(), ['取消', '应用需求 (1)']);
        assert.equal(await page.locator('.tt-constraint-dialog-actions .tt-btn--primary').count(), 1);
        assert.equal(await page.locator('[data-action="apply-constraints"]').count(), 1);

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
            buffer: await readFile(TIMETABLE_CONSTRAINT_WORKBOOK_PATH),
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
        assert.match(realReviewText || '', /可直接应用\s*136\s*项/);
        assert.match(realReviewText || '', /需要确认\s*1\s*项/);
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
        assert.equal(await page.locator('.tt-requirement-row[data-requirement-id]').count(), 1);
        await clickByScript('[data-action="filter-requirements"][data-requirement-filter="rule"]');
        assert.equal(await page.locator('.tt-requirement-row[data-requirement-id]').count(), 136);

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

        const complexSourceMetadata = await page.evaluate(rawTextPrefix => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            const review = planner?.state?.ruleReview || {};
            const source = (review.sourceRequirements || []).find(item => (
                String(item.source?.rawText || item.rawText || '').includes(rawTextPrefix)
            ));
            if (!source) return null;
            return {
                sourceId: source.sourceId,
                rawText: source.source?.rawText || source.rawText || '',
                clauseCount: (source.clauses || []).length,
                unresolvedClauseIds: source.unresolvedClauseIds || [],
                partiallyApplicable: source.partiallyApplicable === true,
                sourceIdsFingerprint: (review.sourceRequirements || []).map(item => item.sourceId).sort().join('|'),
                constraintIrCount: (review.constraintIRs || []).length,
                machineRuleCount: (review.draftRows || []).length,
                sourceCount: (review.sourceRequirements || []).length,
            };
        }, '九年级语文、数学、英语每周尽量有3次以上');
        assert.ok(complexSourceMetadata?.sourceId, JSON.stringify(complexSourceMetadata));
        assert.equal(complexSourceMetadata.clauseCount, 4, JSON.stringify(complexSourceMetadata));
        assert.equal(complexSourceMetadata.unresolvedClauseIds.length, 1, JSON.stringify(complexSourceMetadata));
        assert.equal(complexSourceMetadata.partiallyApplicable, true, JSON.stringify(complexSourceMetadata));
        assert.equal(complexSourceMetadata.sourceCount, 137, JSON.stringify(complexSourceMetadata));
        assert.equal(complexSourceMetadata.constraintIrCount, 154, JSON.stringify(complexSourceMetadata));
        assert.equal(complexSourceMetadata.machineRuleCount, 153, JSON.stringify(complexSourceMetadata));

        await page.evaluate(sourceId => {
            const list = document.querySelector('.tt-requirement-table-body');
            const row = [...document.querySelectorAll('.tt-requirement-row[data-requirement-id]')]
                .find(item => item.dataset.requirementId === sourceId);
            if (!list || !row) throw new Error(`complex source row is unavailable: ${sourceId}`);
            list.scrollTop = Math.max(1, Math.min(list.scrollHeight - list.clientHeight, row.offsetTop - 48));
            row.click();
        }, complexSourceMetadata.sourceId);
        await page.waitForFunction(sourceId => (
            document.querySelector('.tt-requirement-detail[data-requirement-detail-id]')?.dataset.requirementDetailId === sourceId
        ), complexSourceMetadata.sourceId);
        const complexSourceDetailText = await page.locator('.tt-requirement-detail').textContent() || '';
        assert.match(complexSourceDetailText, /语文、数学、英语/);
        assert.match(complexSourceDetailText, /每周至少 3 次/);
        assert.match(complexSourceDetailText, /第1–3节/);
        assert.match(complexSourceDetailText, /九年级 · 10 个班级/);
        assert.doesNotMatch(complexSourceDetailText, /15 个节次/);

        const sourceApplyButton = page.locator('.tt-requirement-detail-actions [data-action="toggle-constraint-apply-item"]');
        assert.equal(await sourceApplyButton.count(), 1);
        const complexApplyItemKey = await sourceApplyButton.getAttribute('data-apply-item-key');
        assert.ok(complexApplyItemKey);
        await sourceApplyButton.click();
        await page.waitForFunction(applyItemKey => (
            window.ICeCream?.appLauncher?.currentToolInstance?.state?.ruleReview?.excludedApplyItemKeys?.includes(applyItemKey)
        ), complexApplyItemKey);

        let sourceEditorAnchor = await page.evaluate(sourceId => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            const review = planner?.state?.ruleReview || {};
            const list = document.querySelector('.tt-requirement-table-body');
            const detail = document.querySelector('.tt-requirement-detail[data-requirement-detail-id]');
            const row = [...document.querySelectorAll('.tt-requirement-row[data-requirement-id]')]
                .find(item => item.dataset.requirementId === sourceId);
            if (!list || !detail || !row) throw new Error('complex source scroll anchor is unavailable');
            list.scrollTop = Math.max(1, Math.min(list.scrollHeight - list.clientHeight, row.offsetTop - 48));
            detail.scrollTop = Math.min(24, Math.max(0, detail.scrollHeight - detail.clientHeight));
            return {
                sourceId,
                listScrollTop: list.scrollTop,
                detailScrollTop: detail.scrollTop,
                excludedApplyItemKeys: [...(review.excludedApplyItemKeys || [])].sort(),
                sourceMachineRuleIds: (review.draftRows || [])
                    .filter(item => item.sourceId === sourceId)
                    .map(item => item.machineRuleId)
                    .sort(),
            };
        }, complexSourceMetadata.sourceId);
        assert.ok(sourceEditorAnchor.listScrollTop > 0, JSON.stringify(sourceEditorAnchor));

        const sourceEditTrigger = page.locator(`[data-action="edit-source-requirement"][data-source-id="${complexSourceMetadata.sourceId}"]`);
        assert.equal(await sourceEditTrigger.count(), 1);
        await sourceEditTrigger.click();
        await page.waitForSelector('.tt-source-requirement-edit-modal', { timeout: 10000 });
        sourceEditorAnchor = await page.evaluate(anchor => ({
            ...anchor,
            listScrollTop: document.querySelector('.tt-requirement-table-body')?.scrollTop ?? -1,
            detailScrollTop: document.querySelector('.tt-requirement-detail')?.scrollTop ?? -1,
        }), sourceEditorAnchor);
        assert.match(await page.locator('.tt-source-editor-original blockquote').textContent() || '', /九年级语文、数学、英语每周尽量有3次以上/);
        assert.equal(await page.locator('.tt-source-editor-original input, .tt-source-editor-original textarea').count(), 0);
        assert.equal(await page.locator('.tt-source-clause-editor').count(), 4);
        assert.equal(await page.locator('.tt-source-clause-summary').count(), 4);
        assert.equal(await page.locator('.tt-source-clause-editor[open]').count(), 0);
        assert.equal(await page.locator('.tt-source-requirement-edit-modal select[multiple]').count(), 0);
        assert.equal(await page.locator('.tt-source-clause-editor .is-unsupported').count(), 1);
        assert.match(await page.locator('.tt-source-clause-editor .is-unsupported').textContent() || '', /已理解，暂未落地/);
        assert.equal(await page.locator('.tt-source-derived-preview').count(), 4);
        assert.match(await page.locator('.tt-source-derived-preview').first().textContent() || '', /当前派生范围：\d+ 个班级/);
        assert.match(await page.locator('.tt-source-clause-summary').first().textContent() || '', /语文/);
        assert.match(await page.locator('.tt-source-clause-summary').first().textContent() || '', /每周至少 3 次/);
        assert.match(await page.locator('.tt-source-clause-summary').first().textContent() || '', /第1–3节/);
        assert.match(await page.locator('.tt-source-clause-summary').first().textContent() || '', /九年级 · 10 个班级/);
        await assertConstraintEditorLayout();

        await page.evaluate(() => document.body.classList.add('light-mode'));
        await page.waitForTimeout(300);
        const lightSourceEditorCancel = await page.evaluate(() => {
            const cancel = document.querySelector('.tt-source-requirement-edit-modal [data-action="cancel-source-requirement-edit"]:not(.tt-constraint-edit-close)');
            const heading = document.querySelector('.tt-source-requirement-edit-modal h3');
            const modal = document.querySelector('.tt-source-requirement-edit-modal');
            const rgba = value => {
                const parts = String(value).match(/[\d.]+/g)?.map(Number) || [];
                return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts.length > 3 ? parts[3] : 1];
            };
            const composite = (front, back) => front.slice(0, 3).map((channel, index) => (
                channel * front[3] + back[index] * (1 - front[3])
            ));
            const luminance = color => {
                const channels = color.map(channel => {
                    const normalized = channel / 255;
                    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
                });
                return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
            };
            const foreground = rgba(cancel ? getComputedStyle(cancel).color : 'rgb(0, 0, 0)').slice(0, 3);
            const modalBackground = rgba(modal ? getComputedStyle(modal).backgroundColor : 'rgb(255, 255, 255)').slice(0, 3);
            const background = composite(rgba(cancel ? getComputedStyle(cancel).backgroundColor : 'rgb(255, 255, 255)'), modalBackground);
            const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
            return {
                text: cancel?.textContent?.trim() || '',
                color: cancel ? getComputedStyle(cancel).color : '',
                headingColor: heading ? getComputedStyle(heading).color : '',
                backgroundColor: cancel ? getComputedStyle(cancel).backgroundColor : '',
                contrast: (values[0] + 0.05) / (values[1] + 0.05),
            };
        });
        assert.equal(lightSourceEditorCancel.text, '取消');
        assert.equal(lightSourceEditorCancel.color, lightSourceEditorCancel.headingColor, JSON.stringify(lightSourceEditorCancel));
        assert.equal(lightSourceEditorCancel.contrast >= 4.5, true, JSON.stringify(lightSourceEditorCancel));
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-source-editor-light.png') });
        await page.evaluate(() => document.body.classList.remove('light-mode'));
        await page.waitForTimeout(300);
        const darkSourceEditorCancelContrast = await page.locator('.tt-source-requirement-edit-modal [data-action="cancel-source-requirement-edit"]:not(.tt-constraint-edit-close)').evaluate(cancel => {
            const rgba = value => {
                const parts = String(value).match(/[\d.]+/g)?.map(Number) || [];
                return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts.length > 3 ? parts[3] : 1];
            };
            const luminance = color => {
                const channels = color.map(channel => {
                    const normalized = channel / 255;
                    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
                });
                return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
            };
            const foreground = rgba(getComputedStyle(cancel).color).slice(0, 3);
            const backgroundValue = rgba(getComputedStyle(cancel).backgroundColor);
            const modalBackground = rgba(getComputedStyle(cancel.closest('.tt-source-requirement-edit-modal')).backgroundColor).slice(0, 3);
            const background = backgroundValue.slice(0, 3).map((channel, index) => channel * backgroundValue[3] + modalBackground[index] * (1 - backgroundValue[3]));
            const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
            return (values[0] + 0.05) / (values[1] + 0.05);
        });
        assert.equal(darkSourceEditorCancelContrast >= 4.5, true, String(darkSourceEditorCancelContrast));
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-source-editor-dark.png') });

        const firstSourceClause = page.locator('.tt-source-clause-editor').first();
        await firstSourceClause.locator('.tt-source-clause-summary').click();
        const darkSourceSelectStyle = await firstSourceClause.locator('[data-source-field="scopeKind"]').evaluate(select => ({
            backgroundColor: getComputedStyle(select).backgroundColor,
            color: getComputedStyle(select).color,
        }));
        assert.notEqual(darkSourceSelectStyle.backgroundColor, 'rgb(255, 255, 255)', JSON.stringify(darkSourceSelectStyle));
        assert.equal(darkSourceSelectStyle.color, 'rgb(241, 245, 249)', JSON.stringify(darkSourceSelectStyle));
        assert.equal(await firstSourceClause.locator('[data-source-option-group="targetIds"]').count(), 1);
        assert.equal(await firstSourceClause.locator('[data-source-field="targetIds"]:checked').count(), 1);
        assert.equal(await firstSourceClause.locator('[data-source-scope-field="gradeNames"]').isVisible(), true);
        assert.equal(await firstSourceClause.locator('[data-source-scope-field="classIds"]').isVisible(), false);
        assert.equal(await firstSourceClause.locator('[data-source-scope-field="teacherIds"]').isVisible(), false);
        await firstSourceClause.locator('[data-source-field="scopeKind"]').selectOption('explicit_classes');
        assert.equal(await firstSourceClause.locator('[data-source-scope-field="classIds"]').isVisible(), true);
        assert.equal(await firstSourceClause.locator('[data-source-scope-field="gradeNames"]').isVisible(), false);
        await firstSourceClause.locator('[data-source-field="scopeKind"]').selectOption('grade_classes');
        await firstSourceClause.locator('[data-source-field="quantifierMin"]').fill('2');
        await page.evaluate(() => window.ICeCream?.appLauncher?.currentToolInstance?.render());
        const rerenderedFirstSourceClause = page.locator('.tt-source-clause-editor').first();
        await rerenderedFirstSourceClause.locator('.tt-source-clause-summary').click();
        assert.equal(await rerenderedFirstSourceClause.locator('[data-source-field="quantifierMin"]').inputValue(), '2');
        await assertConstraintEditorLayout({ requireBodyScroll: true });

        await page.locator('[data-action="save-source-requirement-edit"]').focus();
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => (
            document.querySelector('.tt-source-requirement-edit-modal')?.contains(document.activeElement) === true
        )), true);
        await page.setViewportSize({ width: 390, height: 844 });
        await assertConstraintEditorLayout({ mobile: true, requireBodyScroll: true });
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-source-editor-mobile.png') });
        await page.setViewportSize({ width: 1440, height: 900 });
        await assertConstraintEditorLayout({ requireBodyScroll: true });

        await firstSourceClause.locator('.tt-source-clause-summary').click();
        await assertConstraintEditorLayout();

        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.tt-source-requirement-edit-modal'));
        await page.waitForFunction(sourceId => {
            const active = document.activeElement;
            return active?.dataset?.action === 'edit-source-requirement' && active?.dataset?.sourceId === sourceId;
        }, complexSourceMetadata.sourceId);
        const sourceEscapeResult = await page.evaluate(() => ({
            listScrollTop: document.querySelector('.tt-requirement-table-body')?.scrollTop ?? -1,
            detailScrollTop: document.querySelector('.tt-requirement-detail')?.scrollTop ?? -1,
        }));
        assert.equal(Math.abs(sourceEscapeResult.listScrollTop - sourceEditorAnchor.listScrollTop) <= 1, true, JSON.stringify(sourceEscapeResult));
        assert.equal(Math.abs(sourceEscapeResult.detailScrollTop - sourceEditorAnchor.detailScrollTop) <= 1, true, JSON.stringify(sourceEscapeResult));

        await page.locator(`[data-action="edit-source-requirement"][data-source-id="${complexSourceMetadata.sourceId}"]`).click();
        await page.waitForSelector('.tt-source-requirement-edit-modal', { timeout: 10000 });
        const unsupportedSourceClause = page.locator('.tt-source-clause-editor').filter({
            has: page.locator('.is-unsupported'),
        });
        assert.equal(await unsupportedSourceClause.count(), 1);
        await unsupportedSourceClause.locator('.tt-source-clause-summary').click();
        await unsupportedSourceClause.locator('[data-source-field="keep"]').uncheck();
        for (const clauseEditor of await page.locator('.tt-source-clause-editor').all()) {
            const summary = clauseEditor.locator('.tt-source-clause-summary');
            if (!await clauseEditor.evaluate(node => node.open)) await summary.click();
            await clauseEditor.locator('[data-source-field="keep"]').uncheck();
        }
        await page.locator('[data-action="save-source-requirement-edit"]').click();
        const sourceEditorError = page.locator('.tt-source-editor-errors');
        await sourceEditorError.waitFor({ state: 'visible' });
        assert.equal(await sourceEditorError.evaluate(node => node === document.activeElement), true);
        const clauseEditorsAfterError = page.locator('.tt-source-clause-editor');
        for (let index = 0; index < await clauseEditorsAfterError.count() - 1; index += 1) {
            const clauseEditor = clauseEditorsAfterError.nth(index);
            if (!await clauseEditor.evaluate(node => node.open)) await clauseEditor.locator('.tt-source-clause-summary').click();
            await clauseEditor.locator('[data-source-field="keep"]').check();
        }
        const recompileResponsePromise = page.waitForResponse(response => (
            response.url().includes('/api/tools/timetable/requirements/recompile')
            && response.request().method() === 'POST'
        ), { timeout: 30000 });
        await page.locator('[data-action="save-source-requirement-edit"]').click();
        const recompileResponse = await recompileResponsePromise;
        assert.equal(recompileResponse.ok(), true);
        await page.waitForFunction(() => !document.querySelector('.tt-source-requirement-edit-modal'), null, { timeout: 30000 });
        await page.waitForFunction(sourceId => {
            const active = document.activeElement;
            return active?.dataset?.action === 'edit-source-requirement' && active?.dataset?.sourceId === sourceId;
        }, complexSourceMetadata.sourceId);

        const sourceEditorResult = await page.evaluate(({ sourceId, sourceIdsFingerprint }) => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            const review = planner?.state?.ruleReview || {};
            const source = (review.sourceRequirements || []).find(item => item.sourceId === sourceId);
            const sourceMachineRuleIds = new Set(source?.machineRuleIds || []);
            const sourceRows = (review.draftRows || []).filter(row => (
                row.sourceId === sourceId || sourceMachineRuleIds.has(row.machineRuleId)
            ));
            const active = document.activeElement;
            return {
                clauseCount: (source?.clauses || []).length,
                unresolvedClauseIds: source?.unresolvedClauseIds || [],
                partiallyApplicable: source?.partiallyApplicable === true,
                sourceCount: (review.sourceRequirements || []).length,
                sourceIdsFingerprint: (review.sourceRequirements || []).map(item => item.sourceId).sort().join('|'),
                expectedSourceIdsFingerprint: sourceIdsFingerprint,
                constraintIrCount: (review.constraintIRs || []).length,
                machineRuleCount: (review.draftRows || []).length,
                sourceMachineRuleCount: sourceRows.length,
                sourceMachineStatuses: sourceRows.map(row => row.status),
                sourceMachineRuleIds: sourceRows.map(row => row.machineRuleId).sort(),
                excludedApplyItemKeys: [...(review.excludedApplyItemKeys || [])].sort(),
                sourceApplyItemKey: document.querySelector('.tt-requirement-detail-actions [data-action="toggle-constraint-apply-item"]')?.dataset?.applyItemKey || '',
                selectedRequirementId: planner?.state?.constraintDialog?.selectedRequirementId || '',
                detailRequirementId: document.querySelector('.tt-requirement-detail')?.dataset?.requirementDetailId || '',
                listScrollTop: document.querySelector('.tt-requirement-table-body')?.scrollTop ?? -1,
                detailScrollTop: document.querySelector('.tt-requirement-detail')?.scrollTop ?? -1,
                detailMaxScrollTop: Math.max(0, (document.querySelector('.tt-requirement-detail')?.scrollHeight || 0) - (document.querySelector('.tt-requirement-detail')?.clientHeight || 0)),
                activeSourceId: active?.dataset?.sourceId || '',
            };
        }, {
            sourceId: complexSourceMetadata.sourceId,
            sourceIdsFingerprint: complexSourceMetadata.sourceIdsFingerprint,
        });
        assert.equal(sourceEditorResult.clauseCount, 3, JSON.stringify(sourceEditorResult));
        assert.deepEqual(sourceEditorResult.unresolvedClauseIds, [], JSON.stringify(sourceEditorResult));
        assert.equal(sourceEditorResult.partiallyApplicable, false, JSON.stringify(sourceEditorResult));
        assert.equal(sourceEditorResult.sourceCount, 137, JSON.stringify(sourceEditorResult));
        assert.equal(sourceEditorResult.sourceIdsFingerprint, sourceEditorResult.expectedSourceIdsFingerprint, JSON.stringify(sourceEditorResult));
        assert.equal(sourceEditorResult.constraintIrCount, 153, JSON.stringify(sourceEditorResult));
        assert.equal(sourceEditorResult.machineRuleCount, 153, JSON.stringify(sourceEditorResult));
        assert.equal(sourceEditorResult.sourceMachineRuleCount, 3, JSON.stringify(sourceEditorResult));
        assert.equal(sourceEditorResult.sourceMachineStatuses.every(status => status === 'effective'), true, JSON.stringify(sourceEditorResult));
        assert.deepEqual(
            sourceEditorResult.sourceMachineRuleIds,
            sourceEditorAnchor.sourceMachineRuleIds,
            JSON.stringify({ before: sourceEditorAnchor.sourceMachineRuleIds, after: sourceEditorResult.sourceMachineRuleIds }),
        );
        assert.deepEqual(sourceEditorResult.excludedApplyItemKeys, sourceEditorAnchor.excludedApplyItemKeys, JSON.stringify(sourceEditorResult));
        assert.equal(sourceEditorResult.selectedRequirementId, complexSourceMetadata.sourceId, JSON.stringify(sourceEditorResult));
        assert.equal(sourceEditorResult.detailRequirementId, complexSourceMetadata.sourceId, JSON.stringify(sourceEditorResult));
        assert.equal(Math.abs(sourceEditorResult.listScrollTop - sourceEditorAnchor.listScrollTop) <= 1, true, JSON.stringify(sourceEditorResult));
        assert.equal(
            Math.abs(sourceEditorResult.detailScrollTop - Math.min(sourceEditorAnchor.detailScrollTop, sourceEditorResult.detailMaxScrollTop)) <= 1,
            true,
            JSON.stringify(sourceEditorResult),
        );
        assert.equal(sourceEditorResult.activeSourceId, complexSourceMetadata.sourceId, JSON.stringify(sourceEditorResult));
        assert.match(
            await page.locator('.tt-requirement-detail-actions [data-action="toggle-constraint-apply-item"]').textContent() || '',
            /恢复应用/,
            JSON.stringify({
                excludedApplyItemKeys: sourceEditorResult.excludedApplyItemKeys,
                sourceApplyItemKey: sourceEditorResult.sourceApplyItemKey,
            }),
        );

        const normalizedSourceRules = await page.evaluate(async sourceId => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            const rows = (planner?.state?.ruleReview?.draftRows || []).filter(row => row.sourceId === sourceId);
            const response = await fetch('/api/tools/timetable/rules/normalize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ draftRows: rows, inputType: 'source_requirement_editor_smoke' }),
            });
            const payload = await response.json();
            return {
                ok: response.ok && payload.success,
                statuses: (payload.data?.draftRows || []).map(row => row.status),
                count: (payload.data?.draftRows || []).length,
                error: payload.error || '',
            };
        }, complexSourceMetadata.sourceId);
        assert.equal(normalizedSourceRules.ok, true, JSON.stringify(normalizedSourceRules));
        assert.equal(normalizedSourceRules.count, 3, JSON.stringify(normalizedSourceRules));
        assert.equal(normalizedSourceRules.statuses.every(status => status === 'effective'), true, JSON.stringify(normalizedSourceRules));

        const openRealConstraintEditor = async ({ type = '', advancedType = '' } = {}) => {
            const metadata = await page.evaluate(({ machineType, capabilityType }) => {
                const planner = window.ICeCream?.appLauncher?.currentToolInstance;
                const review = planner?.state?.ruleReview || {};
                const row = (review.draftRows || []).find(item => {
                    const itemAdvancedType = item.advancedType
                        || item.capabilityId
                        || item.parameters?.advancedType
                        || item.parameters?.capabilityId
                        || '';
                    return capabilityType ? itemAdvancedType === capabilityType : item.type === machineType;
                });
                if (!row) return null;
                const source = (review.sourceRequirements || []).find(item => (
                    item.sourceId === row.sourceId
                    || (item.machineRuleIds || []).includes(row.machineRuleId)
                    || (item.clauses || []).some(clause => (
                        clause.id === row.id
                        || clause.machineRuleId === row.machineRuleId
                        || clause.requirementId === row.requirementId
                    ))
                ));
                return {
                    id: row.id,
                    sourceId: source?.sourceId || row.sourceId || row.requirementId,
                    type: row.type,
                    advancedType: row.advancedType || row.capabilityId || row.parameters?.advancedType || row.parameters?.capabilityId || '',
                    machineRuleId: row.machineRuleId,
                    requirementId: row.requirementId,
                    draftCount: (review.draftRows || []).length,
                    requirementCount: (review.requirementItems || []).length,
                    constraintIrCount: (review.constraintIRs || []).length,
                    sourceCount: (review.sourceRequirements || []).length,
                };
            }, { machineType: type, capabilityType: advancedType });
            assert.ok(metadata?.id && metadata?.sourceId, JSON.stringify({ type, advancedType, metadata }));
            await page.evaluate(sourceId => {
                const row = [...document.querySelectorAll('.tt-requirement-row[data-requirement-id]')]
                    .find(item => item.dataset.requirementId === sourceId);
                if (!row) throw new Error(`requirement row is unavailable: ${sourceId}`);
                row.click();
            }, metadata.sourceId);
            await page.waitForFunction(sourceId => (
                document.querySelector('.tt-requirement-detail[data-requirement-detail-id]')?.dataset.requirementDetailId === sourceId
            ), metadata.sourceId);
            await page.evaluate(constraintId => {
                const button = [...document.querySelectorAll('[data-action="edit-constraint"][data-constraint-id]')]
                    .find(item => item.dataset.constraintId === constraintId);
                if (!button) throw new Error(`edit button is unavailable: ${constraintId}`);
                button.click();
            }, metadata.id);
            await page.waitForFunction(constraintId => (
                window.ICeCream?.appLauncher?.currentToolInstance?.state?.constraintDialog?.editingConstraint?.originalId === constraintId
            ), metadata.id);
            await page.waitForSelector('.tt-constraint-edit-modal', { timeout: 10000 });
            return metadata;
        };

        await page.evaluate(() => {
            const list = document.querySelector('.tt-requirement-table-body');
            if (!list) throw new Error('requirement list is unavailable before editor test');
            list.scrollTop = Math.round(Math.max(0, list.scrollHeight - list.clientHeight) * 0.6);
        });
        const teacherEditorMetadata = await openRealConstraintEditor({ type: 'teacher_unavailable' });
        const editorAnchor = await page.evaluate(() => {
            const list = document.querySelector('.tt-requirement-table-body');
            const detail = document.querySelector('.tt-requirement-detail[data-requirement-detail-id]');
            if (detail) detail.scrollTop = Math.min(24, Math.max(0, detail.scrollHeight - detail.clientHeight));
            return {
                listScrollTop: list?.scrollTop ?? -1,
                detailScrollTop: detail?.scrollTop ?? -1,
                requirementId: detail?.dataset.requirementDetailId || '',
            };
        });
        assert.ok(editorAnchor.listScrollTop > 0, JSON.stringify(editorAnchor));
        assert.equal(await page.locator('#tt-edit-constraint-type').inputValue(), 'teacher_unavailable');
        assert.match(await page.locator('[data-rule-field="targetValue"] option:checked').textContent() || '', /刘书涵/);
        assert.equal(await page.locator('[data-rule-field="slots"][value="1-2"]:checked').count(), 1);
        assert.match(await page.locator('.tt-constraint-edit-modal .tt-dialog-header p').textContent() || '', /教师不可排[\s\S]*刘书涵[\s\S]*周一第2节[\s\S]*硬约束/);
        assert.equal(await page.locator('.tt-constraint-rule-unsupported').count(), 0);
        await assertConstraintEditorLayout();
        await page.evaluate(() => document.body.classList.add('light-mode'));
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-rule-editor-light.png') });
        await page.evaluate(() => document.body.classList.remove('light-mode'));
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-rule-editor-dark.png') });
        await page.setViewportSize({ width: 390, height: 844 });
        await assertConstraintEditorLayout({ mobile: true });
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-rule-editor-mobile.png') });
        await page.setViewportSize({ width: 1440, height: 900 });
        await assertConstraintEditorLayout();
        await page.click('[data-action="save-edit-constraint"]');
        await page.waitForFunction(() => !document.querySelector('.tt-constraint-edit-modal'), null, { timeout: 10000 });
        const teacherEditorResult = await page.evaluate(({ metadata, anchor }) => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            const review = planner?.state?.ruleReview || {};
            const row = (review.draftRows || []).find(item => item.id === metadata.id);
            const list = document.querySelector('.tt-requirement-table-body');
            const detail = document.querySelector('.tt-requirement-detail[data-requirement-detail-id]');
            const active = document.activeElement;
            return {
                type: row?.type,
                status: row?.status,
                machineRuleId: row?.machineRuleId,
                requirementId: row?.requirementId,
                listScrollTop: list?.scrollTop ?? -1,
                detailScrollTop: detail?.scrollTop ?? -1,
                selectedRequirementId: detail?.dataset.requirementDetailId || '',
                activeConstraintId: active?.dataset?.constraintId || '',
                draftCount: (review.draftRows || []).length,
                requirementCount: (review.requirementItems || []).length,
                constraintIrCount: (review.constraintIRs || []).length,
                sourceCount: (review.sourceRequirements || []).length,
                anchor,
            };
        }, { metadata: teacherEditorMetadata, anchor: editorAnchor });
        assert.equal(teacherEditorResult.type, 'teacher_unavailable', JSON.stringify(teacherEditorResult));
        assert.equal(teacherEditorResult.status, 'effective', JSON.stringify(teacherEditorResult));
        assert.equal(teacherEditorResult.machineRuleId, teacherEditorMetadata.machineRuleId, JSON.stringify(teacherEditorResult));
        assert.equal(teacherEditorResult.requirementId, teacherEditorMetadata.requirementId, JSON.stringify(teacherEditorResult));
        assert.equal(teacherEditorResult.selectedRequirementId, editorAnchor.requirementId, JSON.stringify(teacherEditorResult));
        assert.equal(Math.abs(teacherEditorResult.listScrollTop - editorAnchor.listScrollTop) <= 1, true, JSON.stringify(teacherEditorResult));
        assert.equal(Math.abs(teacherEditorResult.detailScrollTop - editorAnchor.detailScrollTop) <= 1, true, JSON.stringify(teacherEditorResult));
        assert.equal(teacherEditorResult.activeConstraintId, teacherEditorMetadata.id, JSON.stringify(teacherEditorResult));
        assert.deepEqual(
            [teacherEditorResult.draftCount, teacherEditorResult.requirementCount, teacherEditorResult.constraintIrCount, teacherEditorResult.sourceCount],
            [teacherEditorMetadata.draftCount, teacherEditorMetadata.requirementCount, teacherEditorMetadata.constraintIrCount, teacherEditorMetadata.sourceCount],
        );
        const normalizedTeacherRule = await page.evaluate(async constraintId => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            const row = planner?.state?.ruleReview?.draftRows?.find(item => item.id === constraintId);
            if (!row) throw new Error(`saved rule is unavailable for normalization: ${constraintId}`);
            const response = await fetch('/api/tools/timetable/rules/normalize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ draftRows: [row], inputType: 'constraint_dialog_editor_smoke' }),
            });
            const payload = await response.json();
            return {
                ok: response.ok && payload.success,
                row: payload.data?.draftRows?.[0] || null,
                error: payload.error || '',
            };
        }, teacherEditorMetadata.id);
        assert.equal(normalizedTeacherRule.ok, true, JSON.stringify(normalizedTeacherRule));
        assert.equal(normalizedTeacherRule.row?.status, 'effective', JSON.stringify(normalizedTeacherRule));
        assert.equal(normalizedTeacherRule.row?.id, teacherEditorMetadata.id, JSON.stringify(normalizedTeacherRule));
        assert.equal(normalizedTeacherRule.row?.machineRuleId, teacherEditorMetadata.machineRuleId, JSON.stringify(normalizedTeacherRule));

        const compactEditorMetadata = await openRealConstraintEditor({ advancedType: 'teacher.compact_day' });
        assert.equal(await page.locator('#tt-edit-constraint-type').inputValue(), 'advanced:teacher.compact_day');
        assert.match(await page.locator('[data-rule-field="targetValue"] option:checked').textContent() || '', /刘书涵/);
        assert.ok(await page.locator('[data-rule-field="days"]:checked').count() > 0);
        assert.equal(await page.locator('.tt-constraint-rule-legacy-warning').count(), 0);
        await page.locator('.tt-constraint-edit-close').click();
        await page.waitForFunction(() => !document.querySelector('.tt-constraint-edit-modal'));
        assert.equal(await page.locator('[data-constraint-dialog-overlay]').count(), 1);
        await page.waitForFunction(constraintId => (
            document.activeElement?.dataset?.constraintId === constraintId
        ), compactEditorMetadata.id);

        const roomEditorMetadata = await openRealConstraintEditor({ advancedType: 'room.required' });
        assert.equal(await page.locator('#tt-edit-constraint-type').inputValue(), 'advanced:room.required');
        assert.match(await page.locator('[data-rule-field="targetValue"] option:checked').textContent() || '', /物理/);
        assert.ok(await page.locator('[data-rule-field="activityTypes"]:checked').count() > 0);
        assert.ok(await page.locator('[data-rule-field="roomIds"]:checked').count() > 0);
        assert.ok(await page.locator('[data-rule-field="teacherIds"]').count() > 0);
        await assertConstraintEditorLayout();
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-constraint-rule-editor-advanced.png') });
        await page.locator('.tt-constraint-edit-modal > .tt-dialog-actions [data-action="cancel-edit-constraint"]').click();
        await page.waitForFunction(() => !document.querySelector('.tt-constraint-edit-modal'));
        assert.equal(await page.locator('[data-constraint-dialog-overlay]').count(), 1);
        await page.waitForFunction(constraintId => (
            document.activeElement?.dataset?.constraintId === constraintId
        ), roomEditorMetadata.id);

        const backdropEditorMetadata = await openRealConstraintEditor({ advancedType: 'teacher.compact_day' });
        await page.locator('[data-constraint-edit-backdrop]').click({ position: { x: 4, y: 4 } });
        await page.waitForFunction(() => !document.querySelector('.tt-constraint-edit-modal'));
        assert.equal(await page.locator('[data-constraint-dialog-overlay]').count(), 1);
        await page.waitForFunction(constraintId => (
            document.activeElement?.dataset?.constraintId === constraintId
        ), backdropEditorMetadata.id);

        const representativeEditorRules = [
            { type: 'teacher_max_days_per_week' },
            { type: 'subject_daily_limit' },
            { type: 'global_unavailable' },
            { advancedType: 'room.required' },
            { advancedType: 'subject.not_consecutive_with' },
            { advancedType: 'lesson.consecutive' },
            { advancedType: 'lesson.resource_attribute_avoid_periods' },
        ];
        for (const ruleSelector of representativeEditorRules) {
            const metadata = await openRealConstraintEditor(ruleSelector);
            assert.equal(await page.locator('.tt-constraint-rule-unsupported').count(), 0, JSON.stringify(ruleSelector));
            assert.equal(await page.locator('.tt-constraint-rule-conversion').count(), 0, JSON.stringify(ruleSelector));
            await page.click('[data-action="save-edit-constraint"]');
            await page.waitForFunction(() => !document.querySelector('.tt-constraint-edit-modal'), null, { timeout: 10000 });
            const saved = await page.evaluate(constraintId => {
                const row = window.ICeCream?.appLauncher?.currentToolInstance?.state?.ruleReview?.draftRows
                    ?.find(item => item.id === constraintId);
                return { id: row?.id || '', status: row?.status || '', type: row?.type || '', advancedType: row?.advancedType || row?.capabilityId || row?.parameters?.advancedType || row?.parameters?.capabilityId || '' };
            }, metadata.id);
            assert.equal(saved.id, metadata.id, JSON.stringify({ ruleSelector, saved }));
            assert.equal(saved.status, 'effective', JSON.stringify({ ruleSelector, saved }));
        }

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

        const inspectorFailureMessage = '快速构造已完成 850/900 节，Timefold 在当前时间预算内仍有 42 个硬冲突，涉及跨场地连续课块、教师不可排时段与必需教室资源竞争。请先检查排课审查中的代表性问题后重新生成，诊断末尾。';
        await page.setViewportSize({ width: 1560, height: 950 });
        await page.evaluate(({ failureMessage }) => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            if (!planner) throw new Error('active timetable planner instance is unavailable');
            const statuses = ['violated', 'partial', 'satisfied'];
            const statusLabels = ['未满足', '部分满足', '已满足'];
            const items = Array.from({ length: 24 }, (_, index) => ({
                id: `inspector-stress-rule-${index + 1}`,
                ruleId: `inspector-stress-rule-${index + 1}`,
                type: index % 2 === 0 ? 'subject_preferred_periods' : 'teacher_unavailable',
                status: statuses[index % statuses.length],
                statusLabel: statusLabels[index % statusLabels.length],
                strength: index % 2 === 0 ? 'hard' : 'soft',
                title: `九年级跨场地连续课块与教师不可排时段联合约束 ${index + 1}，需要完整显示而不是单行截断`,
                detail: `证据 ${index + 1}：周五第 8 节与实验室资源、任课教师时间范围和连续课块候选域同时发生冲突，这是一段用于验证换行、行高和滚动边界的长诊断文本。`,
                scopeLabel: `九年级 ${index + 1} 个班级与指定教师覆盖范围`,
                suggestions: [
                    { kind: 'relax_to_soft', label: '改为软约束后重新排课' },
                    { kind: 'shrink_slots', label: '缩小不可排时段范围' },
                    { kind: 'delete_rule', label: '删除这条约束' },
                ],
            }));
            window.localStorage.removeItem('timetable.inspector.position.v1');
            planner.state.inspectorOpen = true;
            planner.state.inspectorPosition = null;
            planner.state.constraintFulfillmentOpen = true;
            planner.state.constraintFulfillmentFilter = 'all';
            planner.state.constraintFulfillment = {
                evaluated: true,
                version: 2,
                summary: {
                    total: items.length,
                    satisfied: 8,
                    partiallySatisfied: 8,
                    violated: 8,
                    notEvaluable: 0,
                },
                items,
            };
            planner.state.lastFailure = {
                reason: 'search_exhausted',
                message: failureMessage,
                solverStats: {
                    lessonCount: 900,
                    timeoutSeconds: 180,
                    hardScore: -42,
                },
            };
            planner.render();
        }, { failureMessage: inspectorFailureMessage });
        await page.waitForSelector('.tt-inspector-drawer[open] .tt-constraint-fulfillment-row', { timeout: 10000 });

        const inspectInspectorGeometry = async ({ mobile = false } = {}) => {
            const layout = await page.evaluate(() => {
                const inspector = document.querySelector('.tt-inspector');
                const drawer = document.querySelector('.tt-inspector-drawer');
                const summary = document.querySelector('.tt-inspector-summary');
                const closeButton = document.querySelector('[data-action="close-inspector"]');
                const resizeHandle = document.querySelector('[data-inspector-resize-handle]');
                const status = document.querySelector('.tt-inspector-summary-status');
                const body = document.querySelector('.tt-inspector-body');
                const list = document.querySelector('.tt-constraint-fulfillment-list');
                if (!inspector || !drawer || !summary || !body || !list) {
                    throw new Error('inspector stress fixture did not render');
                }
                const systemDetails = document.querySelector('[data-inspector-section="system"]');
                if (systemDetails) systemDetails.open = true;
                const rectOf = element => {
                    if (!element) return null;
                    const rect = element.getBoundingClientRect();
                    return {
                        left: rect.left,
                        right: rect.right,
                        top: rect.top,
                        bottom: rect.bottom,
                        width: rect.width,
                        height: rect.height,
                    };
                };
                const rows = [...list.querySelectorAll('.tt-constraint-fulfillment-row')].map(row => {
                    const status = row.querySelector('.tt-constraint-fulfillment-status');
                    const main = row.querySelector('.tt-constraint-fulfillment-main');
                    const meta = row.querySelector('.tt-constraint-fulfillment-meta');
                    const actions = row.querySelector('.tt-constraint-fulfillment-actions');
                    const title = main?.querySelector('strong');
                    const detail = main?.querySelector('em');
                    return {
                        row: rectOf(row),
                        status: rectOf(status),
                        main: rectOf(main),
                        meta: rectOf(meta),
                        actions: rectOf(actions),
                        buttons: [...(actions?.querySelectorAll('button') || [])].map(rectOf),
                        titleWhiteSpace: title ? getComputedStyle(title).whiteSpace : '',
                        detailWhiteSpace: detail ? getComputedStyle(detail).whiteSpace : '',
                        titleOverflowWrap: title ? getComputedStyle(title).overflowWrap : '',
                        detailOverflowWrap: detail ? getComputedStyle(detail).overflowWrap : '',
                    };
                });
                const failure = [...document.querySelectorAll('.tt-inspector .tt-detail-list .is-warning')]
                    .find(element => (element.textContent || '').includes('失败原因'));
                const outerScrollCandidates = [];
                for (let ancestor = inspector.parentElement; ancestor; ancestor = ancestor.parentElement) {
                    const style = getComputedStyle(ancestor);
                    if (['auto', 'scroll'].includes(style.overflowY)) outerScrollCandidates.push(ancestor);
                }
                const outerScrollingElement = outerScrollCandidates.find(element => element.scrollHeight > element.clientHeight)
                    || document.scrollingElement
                    || document.documentElement;
                const summaryBefore = rectOf(summary);
                body.scrollTop = body.scrollHeight;
                const summaryAfterLocalScroll = rectOf(summary);
                outerScrollingElement.scrollTop = outerScrollingElement.scrollHeight;
                const scroll = {
                    listTop: list.scrollTop,
                    listMax: Math.max(0, list.scrollHeight - list.clientHeight),
                    bodyTop: body.scrollTop,
                    bodyMax: Math.max(0, body.scrollHeight - body.clientHeight),
                    outerTop: outerScrollingElement.scrollTop,
                    outerMax: Math.max(0, outerScrollingElement.scrollHeight - outerScrollingElement.clientHeight),
                    outerClassName: outerScrollingElement.className || outerScrollingElement.tagName,
                    summaryBefore,
                    summaryAfter: summaryAfterLocalScroll,
                };
                body.scrollTop = 0;
                outerScrollingElement.scrollTop = 0;
                const inspectorStyle = getComputedStyle(inspector);
                const bodyStyle = getComputedStyle(body);
                const listStyle = getComputedStyle(list);
                const failureStyle = failure ? getComputedStyle(failure) : null;
                return {
                    viewport: { width: window.innerWidth, height: window.innerHeight },
                    documentWidth: document.documentElement.scrollWidth,
                    inspector: rectOf(inspector),
                    drawer: rectOf(drawer),
                    summary: rectOf(summary),
                    hasCloseButton: Boolean(closeButton),
                    hasResizeHandle: Boolean(resizeHandle),
                    statusText: status?.textContent?.trim() || '',
                    body: rectOf(body),
                    list: rectOf(list),
                    inspectorClientWidth: inspector.clientWidth,
                    inspectorScrollWidth: inspector.scrollWidth,
                    bodyClientWidth: body.clientWidth,
                    bodyScrollWidth: body.scrollWidth,
                    listClientWidth: list.clientWidth,
                    listScrollWidth: list.scrollWidth,
                    position: inspectorStyle.position,
                    transform: inspectorStyle.transform,
                    bodyOverflowY: bodyStyle.overflowY,
                    listOverflowY: listStyle.overflowY,
                    listOverscrollBehaviorY: listStyle.overscrollBehaviorY,
                    failure: failure ? {
                        rect: rectOf(failure),
                        clientWidth: failure.clientWidth,
                        scrollWidth: failure.scrollWidth,
                        whiteSpace: failureStyle.whiteSpace,
                        overflowWrap: failureStyle.overflowWrap,
                        text: (failure.textContent || '').replace(/\s+/g, ' ').trim(),
                    } : null,
                    rows,
                    scroll,
                };
            });
            const inside = (child, parent, tolerance = 1) => child
                && parent
                && child.left >= parent.left - tolerance
                && child.right <= parent.right + tolerance
                && child.top >= parent.top - tolerance
                && child.bottom <= parent.bottom + tolerance;
            assert.equal(layout.documentWidth <= layout.viewport.width, true, JSON.stringify(layout));
            assert.equal(layout.hasCloseButton, true, JSON.stringify(layout));
            assert.ok(layout.statusText, JSON.stringify(layout));
            assert.equal(layout.inspectorScrollWidth <= layout.inspectorClientWidth + 1, true, JSON.stringify(layout));
            assert.equal(layout.bodyScrollWidth <= layout.bodyClientWidth + 1, true, JSON.stringify(layout));
            assert.equal(layout.listScrollWidth <= layout.listClientWidth + 1, true, JSON.stringify(layout));
            assert.equal(['auto', 'scroll'].includes(layout.bodyOverflowY), true, JSON.stringify(layout));
            assert.equal(layout.listOverflowY, 'visible', JSON.stringify(layout));
            assert.equal(layout.scroll.listMax, 0, JSON.stringify(layout));
            if (mobile) {
                assert.equal(layout.scroll.outerMax > 0 && Math.abs(layout.scroll.outerTop - layout.scroll.outerMax) <= 1, true, JSON.stringify(layout));
            } else {
                assert.equal(layout.scroll.bodyMax > 0 && Math.abs(layout.scroll.bodyTop - layout.scroll.bodyMax) <= 1, true, JSON.stringify(layout));
            }
            assert.equal(Math.abs(layout.scroll.summaryBefore.top - layout.scroll.summaryAfter.top) <= 1, true, JSON.stringify(layout));
            assert.equal(Math.abs(layout.scroll.summaryBefore.bottom - layout.scroll.summaryAfter.bottom) <= 1, true, JSON.stringify(layout));
            assert.ok(layout.failure, JSON.stringify(layout));
            assert.match(layout.failure.text, /诊断末尾/);
            assert.equal(layout.failure.whiteSpace, 'normal', JSON.stringify(layout.failure));
            assert.equal(layout.failure.scrollWidth <= layout.failure.clientWidth + 1, true, JSON.stringify(layout.failure));
            assert.equal(layout.rows.length, 24, JSON.stringify(layout));
            for (const row of layout.rows) {
                assert.equal(inside(row.status, row.row), true, JSON.stringify(row));
                assert.equal(inside(row.main, row.row), true, JSON.stringify(row));
                assert.equal(inside(row.meta, row.row), true, JSON.stringify(row));
                if (row.actions) assert.equal(inside(row.actions, row.row), true, JSON.stringify(row));
                assert.equal(row.status.right <= row.main.left + 1, true, JSON.stringify(row));
                assert.equal(row.main.bottom <= row.meta.top + 1, true, JSON.stringify(row));
                if (row.actions) assert.equal(row.meta.bottom <= row.actions.top + 1, true, JSON.stringify(row));
                assert.equal(row.titleWhiteSpace, 'normal', JSON.stringify(row));
                assert.equal(row.detailWhiteSpace, 'normal', JSON.stringify(row));
                assert.equal(row.titleOverflowWrap, 'anywhere', JSON.stringify(row));
                assert.equal(row.detailOverflowWrap, 'anywhere', JSON.stringify(row));
                assert.equal(row.buttons.length, 0, JSON.stringify(row));
            }
            if (mobile) {
                assert.equal(layout.position, 'static', JSON.stringify(layout));
                assert.equal(layout.transform, 'none', JSON.stringify(layout));
                assert.equal(layout.inspector.left >= 0 && layout.inspector.right <= layout.viewport.width + 1, true, JSON.stringify(layout));
            } else {
                assert.ok(layout.inspector.width >= 480, JSON.stringify(layout));
                assert.equal(layout.hasResizeHandle, true, JSON.stringify(layout));
                assert.equal(layout.position, 'fixed', JSON.stringify(layout));
                assert.equal(layout.inspector.left >= 12 && layout.inspector.right <= layout.viewport.width - 12 + 1, true, JSON.stringify(layout));
                assert.equal(layout.inspector.top >= 12 && layout.drawer.bottom <= layout.viewport.height - 12 + 1, true, JSON.stringify(layout));
            }
            return layout;
        };

        await page.evaluate(() => document.body.classList.add('light-mode'));
        await inspectInspectorGeometry();
        await page.locator('.tt-constraint-fulfillment-row[data-constraint-fulfillment-row="inspector-stress-rule-1"] .tt-constraint-fulfillment-row-summary').click();
        await page.waitForSelector('.tt-constraint-fulfillment-row[data-constraint-fulfillment-row="inspector-stress-rule-1"].is-expanded');
        const firstExpanded = await page.evaluate(() => {
            const row = document.querySelector('.tt-constraint-fulfillment-row[data-constraint-fulfillment-row="inspector-stress-rule-1"]');
            const detail = row?.querySelector('.tt-constraint-fulfillment-detail');
            return {
                expanded: row?.classList.contains('is-expanded'),
                evidence: detail?.querySelector('.tt-constraint-fulfillment-evidence')?.textContent || '',
                deleteButton: detail?.querySelector('[data-constraint-fulfillment-suggestion="delete_rule"]') !== null,
                manualNotes: detail?.querySelectorAll('.tt-constraint-fulfillment-action-note').length || 0,
            };
        });
        assert.equal(firstExpanded.expanded, true, JSON.stringify(firstExpanded));
        assert.match(firstExpanded.evidence, /这是一段用于验证换行/);
        assert.equal(firstExpanded.deleteButton, true, JSON.stringify(firstExpanded));
        assert.equal(firstExpanded.manualNotes, 2, JSON.stringify(firstExpanded));
        await page.locator('.tt-constraint-fulfillment-row[data-constraint-fulfillment-row="inspector-stress-rule-2"] .tt-constraint-fulfillment-row-summary').click();
        const expansionState = await page.evaluate(() => [...document.querySelectorAll('.tt-constraint-fulfillment-row')]
            .map(row => ({ id: row.dataset.constraintFulfillmentRow, expanded: row.classList.contains('is-expanded') })));
        assert.equal(expansionState.filter(item => item.expanded).length, 1, JSON.stringify(expansionState));
        assert.equal(expansionState.find(item => item.id === 'inspector-stress-rule-1')?.expanded, false, JSON.stringify(expansionState));
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-inspector-drag-layout-desktop.png') });

        const dragHandle = page.locator('[data-inspector-drag-handle]');
        const dragBox = await dragHandle.boundingBox();
        assert.ok(dragBox);
        const dragStart = { x: dragBox.x + dragBox.width / 2, y: dragBox.y + Math.min(20, dragBox.height / 2) };
        const dragEnd = { x: 280, y: 150 };
        await page.mouse.move(dragStart.x, dragStart.y);
        await page.mouse.down();
        for (let step = 1; step <= 36; step += 1) {
            const ratio = step / 36;
            await page.mouse.move(
                dragStart.x + ((dragEnd.x - dragStart.x) * ratio),
                dragStart.y + ((dragEnd.y - dragStart.y) * ratio),
            );
        }
        await page.mouse.up();
        const draggedInspector = await page.evaluate(() => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            const inspector = document.querySelector('.tt-inspector');
            const drawer = document.querySelector('.tt-inspector-drawer');
            const rect = inspector.getBoundingClientRect();
            return {
                statePosition: planner?.state?.inspectorPosition || null,
                cachedPosition: JSON.parse(window.localStorage.getItem('timetable.inspector.position.v1') || 'null'),
                rect: { left: rect.left, top: rect.top },
                open: drawer.open,
                dragging: inspector.classList.contains('is-dragging'),
            };
        });
        assert.ok(draggedInspector.statePosition, JSON.stringify(draggedInspector));
        assert.deepEqual(draggedInspector.cachedPosition, draggedInspector.statePosition);
        assert.equal(Math.abs(draggedInspector.rect.left - draggedInspector.statePosition.x) <= 1, true, JSON.stringify(draggedInspector));
        assert.equal(Math.abs(draggedInspector.rect.top - draggedInspector.statePosition.y) <= 1, true, JSON.stringify(draggedInspector));
        assert.equal(draggedInspector.open, true, JSON.stringify(draggedInspector));
        assert.equal(draggedInspector.dragging, false, JSON.stringify(draggedInspector));

        await page.evaluate(() => window.ICeCream?.appLauncher?.currentToolInstance?.render());
        await page.waitForSelector('.tt-inspector-drawer[open] .tt-constraint-fulfillment-row');
        const restoredInspector = await page.evaluate(() => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            const rect = document.querySelector('.tt-inspector').getBoundingClientRect();
            return {
                statePosition: planner?.state?.inspectorPosition || null,
                cachedPosition: JSON.parse(window.localStorage.getItem('timetable.inspector.position.v1') || 'null'),
                rect: { left: rect.left, top: rect.top },
            };
        });
        assert.deepEqual(restoredInspector.cachedPosition, restoredInspector.statePosition);
        assert.equal(Math.abs(restoredInspector.rect.left - restoredInspector.statePosition.x) <= 1, true, JSON.stringify(restoredInspector));
        assert.equal(Math.abs(restoredInspector.rect.top - restoredInspector.statePosition.y) <= 1, true, JSON.stringify(restoredInspector));

        await page.setViewportSize({ width: 1280, height: 720 });
        await page.evaluate(() => {
            document.body.classList.remove('light-mode');
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            if (planner?.state) planner.state.constraintFulfillmentExpandedRowId = '';
            planner?.render();
        });
        await page.waitForSelector('.tt-inspector-drawer[open] .tt-constraint-fulfillment-row');
        await inspectInspectorGeometry();
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-inspector-drag-layout-narrow.png') });

        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => {
            const planner = window.ICeCream?.appLauncher?.currentToolInstance;
            if (planner?.state) planner.state.constraintFulfillmentExpandedRowId = '';
            planner?.render();
        });
        await page.waitForSelector('.tt-inspector-drawer[open] .tt-constraint-fulfillment-row');
        await inspectInspectorGeometry({ mobile: true });
        await page.locator('.tt-constraint-fulfillment-section').screenshot({ path: path.join(ARTIFACT_DIR, 'timetable-inspector-drag-layout-mobile.png') });

        console.log('timetable rule review smoke passed');
    });
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
