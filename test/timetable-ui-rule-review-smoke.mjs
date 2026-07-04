import assert from 'node:assert/strict';

import { withOpenedTimetablePage } from './timetable-ui-smoke-helpers.mjs';

async function main() {
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
                () => document.querySelectorAll('.tt-constraint-card').length === 0,
                { timeout: 10000 },
            );
        };

        const recognizedText = async () => page.textContent('[data-constraint-dialog-overlay]');

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

        const reviewText = await recognizedText();
        assert.match(reviewText || '', /已识别约束/);
        assert.match(reviewText || '', /语文/);
        assert.match(reviewText || '', /上午/);

        await clearRecognizedConstraints();

        await clickByScript('[data-action="switch-constraint-mode"][data-mode="file"]');
        await page.locator('#tt-constraint-file-input').setInputFiles({
            name: 'smart-constraints.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('数学尽量安排到上午', 'utf8'),
        });
        await page.waitForFunction(
            () => /smart-constraints\.txt/.test(document.querySelector('[data-constraint-dialog-overlay]')?.textContent || ''),
            { timeout: 10000 },
        );
        await clickByScript('[data-action="parse-constraints"]');
        await page.waitForFunction(() => document.querySelectorAll('.tt-constraint-card').length > 0, { timeout: 30000 });

        const fileReviewText = await recognizedText();
        assert.match(fileReviewText || '', /已识别约束/);
        assert.match(fileReviewText || '', /数学/);
        assert.match(fileReviewText || '', /上午/);
        assert.equal(dialogs.some(item => item.message === '请选择文件'), false);

        await clearRecognizedConstraints();

        await clickByScript('[data-action="switch-constraint-mode"][data-mode="manual"]');
        await page.fill('#tt-manual-target', '数学');
        await page.fill('#tt-manual-time', '周一上午');
        await clickByScript('[data-action="add-manual-constraint"]');
        await page.waitForFunction(() => document.querySelectorAll('.tt-constraint-card').length > 0, { timeout: 10000 });

        const manualReviewText = await recognizedText();
        assert.match(manualReviewText || '', /已识别约束/);
        assert.match(manualReviewText || '', /手动添加/);
        assert.match(manualReviewText || '', /周一上午/);

        await clickByScript('[data-action="apply-constraints"]');
        await page.waitForFunction(() => !document.querySelector('[data-constraint-dialog-overlay]'), { timeout: 10000 });
        assert.ok(dialogs.some(item => item.message === '成功应用 1 条约束'));

        console.log('timetable rule review smoke passed');
    });
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
