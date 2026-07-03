import assert from 'node:assert/strict';

import { withOpenedTimetablePage } from './timetable-ui-smoke-helpers.mjs';

async function main() {
    await withOpenedTimetablePage({ port: 3139 }, async ({ page }) => {
        const clickByScript = async selector => {
            await page.locator(selector).evaluate(element => element.click());
        };
        page.on('dialog', dialog => dialog.accept());

        await page.click('#tt-open-roster-import');
        await page.waitForSelector('#tt-roster-import-dialog', { timeout: 10000 });

        await page.click('#tt-fill-roster-sample');
        await page.click('#tt-preview-roster-import');
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

        await page.fill('#tt-constraint-text-input', '语文尽量安排到上午');
        await clickByScript('[data-action="parse-constraints"]');

        await page.waitForFunction(() => document.querySelectorAll('.tt-constraint-card').length > 0, { timeout: 30000 });

        const reviewText = await page.textContent('[data-constraint-dialog-overlay]');
        assert.match(reviewText || '', /已识别约束/);
        assert.match(reviewText || '', /语文/);
        assert.match(reviewText || '', /上午/);

        await clickByScript('[data-action="apply-constraints"]');
        await page.waitForFunction(() => !document.querySelector('[data-constraint-dialog-overlay]'), { timeout: 10000 });

        console.log('timetable rule review smoke passed');
    });
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
