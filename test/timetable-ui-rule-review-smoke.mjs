import assert from 'node:assert/strict';

import { withOpenedTimetablePage } from './timetable-ui-smoke-helpers.mjs';

async function main() {
    await withOpenedTimetablePage({ port: 3139 }, async ({ page }) => {
        const clickByScript = async selector => {
            await page.locator(selector).evaluate(element => element.click());
        };

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
        await page.waitForSelector('[data-smart-workbench-root]', { timeout: 10000 });
        await page.waitForFunction(() => {
            const root = document.querySelector('[data-smart-workbench-root]');
            const stage = root?.getAttribute('data-smart-stage') || '';
            return ['checking_data', 'ready_for_constraints'].includes(stage);
        }, { timeout: 20000 });
        await page.waitForFunction(() => {
            const root = document.querySelector('[data-smart-workbench-root]');
            const stage = root?.getAttribute('data-smart-stage') || '';
            return stage !== 'checking_data';
        }, { timeout: 20000 });

        const continueToInput = page.locator('[data-action="smart-workbench-continue-input"]');
        if (await continueToInput.count()) {
            await clickByScript('[data-action="smart-workbench-continue-input"]');
        }

        await page.waitForFunction(() => {
            const root = document.querySelector('[data-smart-workbench-root]');
            return root && root.getAttribute('data-smart-stage') === 'ready_for_constraints';
        }, { timeout: 20000 });

        await clickByScript('[data-rule-review-mode="text"]');
        await page.waitForSelector('#tt-rule-review-text', { timeout: 10000 });

        await page.fill('#tt-rule-review-text', '语文尽量安排到上午');
        await clickByScript('#tt-rule-review-parse');

        await page.waitForFunction(() => {
            const root = document.querySelector('[data-smart-workbench-root]');
            const stage = root?.getAttribute('data-smart-stage') || '';
            return ['reviewing_constraints', 'waiting_user_confirmation'].includes(stage);
        }, { timeout: 30000 });
        await page.waitForFunction(() => document.querySelectorAll('.tt-smart-rule-list [data-rule-id]').length > 0, { timeout: 30000 });

        const reviewText = await page.textContent('[data-smart-workbench-root]');
        assert.match(reviewText || '', /规则报告/);
        assert.match(reviewText || '', /语文/);
        assert.match(reviewText || '', /上午/);

        await clickByScript('[data-action="smart-workbench-preview-rules"]');
        await page.waitForFunction(() => {
            const root = document.querySelector('[data-smart-workbench-root]');
            return root && root.getAttribute('data-smart-stage') === 'waiting_user_confirmation';
        }, { timeout: 30000 });
        await page.waitForSelector('#tt-confirm-rule-review', { timeout: 10000 });

        const previewText = await page.textContent('[data-smart-workbench-root]');
        assert.match(previewText || '', /确认规则变化/);
        assert.match(previewText || '', /语文/);

        await clickByScript('#tt-confirm-rule-review');
        await page.waitForFunction(() => {
            const root = document.querySelector('[data-smart-workbench-root]');
            const stage = root?.getAttribute('data-smart-stage') || '';
            return ['building_solve_plan', 'waiting_solve_approval'].includes(stage);
        }, { timeout: 30000 });
        await page.waitForFunction(() => {
            const root = document.querySelector('[data-smart-workbench-root]');
            const text = root?.textContent || '';
            return /1\s*已生效|已生效\s*1/.test(text);
        }, { timeout: 30000 });

        const stage = await page.locator('[data-smart-workbench-root]').getAttribute('data-smart-stage');
        assert.match(stage || '', /building_solve_plan|waiting_solve_approval/);

        const postConfirmText = await page.textContent('[data-smart-workbench-root]');
        assert.match(postConfirmText || '', /求解计划|准备排课计划/);
        assert.match(postConfirmText || '', /1\s*已生效|已生效\s*1/);

        console.log('timetable rule review smoke passed');
    });
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
