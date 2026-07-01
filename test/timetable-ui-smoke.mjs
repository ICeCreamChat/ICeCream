import assert from 'node:assert/strict';

import { withOpenedTimetablePage } from './timetable-ui-smoke-helpers.mjs';

async function main() {
    await withOpenedTimetablePage({ port: 3137 }, async ({ page }) => {
        const title = await page.textContent('.tool-title');
        assert.match(title || '', /智能排课/);

        const diagnosticsTitle = await page.textContent('.tt-inspector-summary');
        assert.ok(diagnosticsTitle);
        console.log('timetable ui smoke passed');
    });
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
