import assert from 'node:assert/strict';

import { withOpenedTimetablePage } from './timetable-ui-smoke-helpers.mjs';

async function main() {
    await withOpenedTimetablePage({ port: 3138 }, async ({ page }) => {
        await page.click('#tt-open-roster-import');
        await page.waitForSelector('#tt-roster-import-dialog', { timeout: 10000 });

        await page.click('#tt-fill-roster-sample');
        const rosterText = await page.locator('#tt-roster-import-text').inputValue();
        assert.match(rosterText, /七年级,1班,数学,陈老师,4,单节/);

        await page.click('[data-roster-import-submit="text"]');
        await page.waitForFunction(() => {
            const title = document.querySelector('#tt-roster-import-title');
            return title && /检查任课数据/.test(title.textContent || '');
        }, { timeout: 20000 });

        const reviewRows = await page.locator('[data-roster-review-row]').count();
        assert.ok(reviewRows >= 8, `expected imported review rows, got ${reviewRows}`);

        await page.click('#tt-confirm-roster-import');
        await page.waitForFunction(() => !document.querySelector('#tt-roster-import-dialog'), { timeout: 20000 });

        const rosterChip = await page.textContent('[data-workflow-step="data"] .tt-chip');
        assert.match(rosterChip || '', /8 条/);

        await page.click('#tt-run-schedule');
        await page.waitForFunction(() => document.querySelectorAll('.tt-slot').length > 0, { timeout: 30000 });

        const slotCount = await page.locator('.tt-slot').count();
        assert.ok(slotCount > 0, 'expected generated timetable slots');

        await page.waitForFunction(() => {
            const button = document.querySelector('#tt-publish-schedule');
            return button && !button.disabled;
        }, { timeout: 20000 });

        const publishTitle = await page.locator('#tt-publish-schedule').getAttribute('title');
        assert.match(publishTitle || '', /发布当前课表/);

        await page.click('#tt-publish-schedule');
        await page.waitForSelector('#tt-publish-dialog', { timeout: 10000 });
        await page.fill('#tt-publish-note', 'workflow smoke');

        const publishSummary = await page.textContent('#tt-publish-dialog .tt-publish-summary');
        assert.match(publishSummary || '', /课时/);
        assert.match(publishSummary || '', /硬冲突/);
        assert.match(publishSummary || '', /未排/);

        await page.click('#tt-confirm-publish');
        await page.waitForFunction(() => !document.querySelector('#tt-publish-dialog'), { timeout: 20000 });
        await page.waitForFunction(() => {
            const chip = document.querySelector('[data-workflow-step="review"] .tt-chip');
            return chip && /已发布 V\d+/.test(chip.textContent || '');
        }, { timeout: 20000 });
        await page.waitForFunction(() => {
            const message = document.querySelector('.tt-message');
            return message && /课表已发布 V\d+/.test(message.textContent || '');
        }, { timeout: 20000 });

        const publishStatus = await page.textContent('[data-workflow-step="review"] .tt-chip');
        assert.match(publishStatus || '', /已发布 V\d+/);

        const topbarMessage = await page.textContent('.tt-message');
        assert.match(topbarMessage || '', /课表已发布 V\d+/);

        const classExportTitle = await page.locator('[data-export-type="class"]').getAttribute('title');
        assert.match(classExportTitle || '', /导出班级课表/);

        await page.click('[data-export-type="class"]');
        await page.waitForFunction(() => {
            const message = document.querySelector('.tt-message');
            return message && /导出已开始/.test(message.textContent || '');
        }, { timeout: 30000 });

        const exportMessage = await page.textContent('.tt-message');
        assert.match(exportMessage || '', /导出已开始/);

        await page.evaluate(() => {
            const toggle = document.querySelector('[data-tt-section-toggle="data"]');
            if (toggle?.getAttribute('aria-expanded') !== 'true') toggle.click();
        });
        await page.waitForFunction(() => {
            const panel = document.querySelector('[data-workflow-step="data"]');
            return panel && panel.classList.contains('is-open');
        }, { timeout: 10000 });

        await page.click('#tt-clear-roster');
        await page.waitForFunction(() => {
            const message = document.querySelector('.tt-message');
            return message && /任课数据已清空/.test(message.textContent || '');
        }, { timeout: 30000 });
        await page.waitForFunction(() => {
            const restore = document.querySelector('[data-restore-published-snapshot="latest"]');
            const empty = document.querySelector('.tt-empty');
            return restore && empty && /当前草稿已清空/.test(empty.textContent || '');
        }, { timeout: 30000 });

        const clearedMessage = await page.textContent('.tt-message');
        assert.match(clearedMessage || '', /任课数据已清空/);

        await page.click('[data-restore-published-snapshot="latest"]');
        await page.waitForSelector('#tt-restore-dialog', { timeout: 10000 });

        const restoreDialog = await page.textContent('#tt-restore-dialog');
        assert.match(restoreDialog || '', /恢复发布版/);
        assert.match(restoreDialog || '', /当前草稿将被覆盖/);

        await page.click('#tt-confirm-restore');
        await page.waitForFunction(() => !document.querySelector('#tt-restore-dialog'), { timeout: 30000 });
        await page.waitForFunction(() => document.querySelectorAll('.tt-slot').length > 0, { timeout: 30000 });
        await page.waitForFunction(() => {
            const message = document.querySelector('.tt-message');
            return message && /已恢复发布版 V\d+ 为当前草稿/.test(message.textContent || '');
        }, { timeout: 30000 });
        await page.waitForFunction(() => {
            const chip = document.querySelector('[data-workflow-step="review"] .tt-chip');
            return chip && /草稿已变化/.test(chip.textContent || '');
        }, { timeout: 30000 });

        const restoredMessage = await page.textContent('.tt-message');
        assert.match(restoredMessage || '', /已恢复发布版 V\d+ 为当前草稿/);

        const restoredStatus = await page.textContent('[data-workflow-step="review"] .tt-chip');
        assert.match(restoredStatus || '', /草稿已变化/);

        await page.waitForFunction(() => {
            const button = document.querySelector('#tt-publish-schedule');
            return button && !button.disabled;
        }, { timeout: 20000 });
        await page.click('#tt-publish-schedule');
        await page.waitForSelector('#tt-publish-dialog', { timeout: 10000 });
        await page.fill('#tt-publish-note', 'workflow republish');
        await page.click('#tt-confirm-publish');
        await page.waitForFunction(() => !document.querySelector('#tt-publish-dialog'), { timeout: 30000 });
        await page.waitForFunction(() => {
            const chip = document.querySelector('[data-workflow-step="review"] .tt-chip');
            return chip && /已发布 V2/.test(chip.textContent || '');
        }, { timeout: 30000 });
        await page.waitForFunction(() => document.querySelector('[data-publication-history-version="1"]'), { timeout: 30000 });

        const republishedStatus = await page.textContent('[data-workflow-step="review"] .tt-chip');
        assert.match(republishedStatus || '', /已发布 V2/);

        await page.click('[data-publication-history-version="1"]');
        await page.waitForSelector('#tt-publication-history-dialog', { timeout: 10000 });

        const historyText = await page.textContent('#tt-publication-history-dialog');
        assert.match(historyText || '', /发布版本 V1/);
        assert.match(historyText || '', /导出该历史版本/);

        await page.click('[data-export-history-type="published_class"]');
        await page.waitForFunction(() => {
            const message = document.querySelector('.tt-message');
            return message && /导出已开始/.test(message.textContent || '');
        }, { timeout: 30000 });

        const historyExportMessage = await page.textContent('.tt-message');
        assert.match(historyExportMessage || '', /导出已开始/);

        console.log('timetable workflow smoke passed');
    });
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
