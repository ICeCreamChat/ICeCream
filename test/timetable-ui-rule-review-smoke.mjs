import assert from 'node:assert/strict';

import AdmZip from 'adm-zip';

import { withOpenedTimetablePage } from './timetable-ui-smoke-helpers.mjs';

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

        await page.fill('#tt-constraint-text-input', '语文尽量安排到上午');
        await clickByScript('[data-action="parse-constraints"]');

        await page.waitForSelector('.tt-requirement-workbench', { timeout: 30000 });

        const reviewText = await recognizedText();
        assert.match(reviewText || '', /解析结果/);
        assert.match(reviewText || '', /来自你的输入/);
        assert.match(reviewText || '', /落地结果/);
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
        await page.waitForSelector('.tt-requirement-workbench', { timeout: 30000 });

        const fileReviewText = await recognizedText();
        assert.match(fileReviewText || '', /解析结果/);
        assert.match(fileReviewText || '', /来自你的输入/);
        assert.match(fileReviewText || '', /落地结果/);
        assert.match(fileReviewText || '', /数学/);
        assert.match(fileReviewText || '', /上午/);
        assert.equal(dialogs.some(item => item.message === '请选择文件'), false);

        await clearRecognizedConstraints();

        await clickByScript('[data-action="switch-constraint-mode"][data-mode="file"]');
        await page.locator('#tt-constraint-file-input').setInputFiles({
            name: 'AI排课约束建议.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            buffer: buildConstraintWorkbook([
                ['约束内容'],
                ['英语尽量安排到上午'],
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
        assert.match(xlsxReviewText || '', /来自你的输入/);
        assert.match(xlsxReviewText || '', /落地结果/);
        assert.match(xlsxReviewText || '', /英语/);
        assert.match(xlsxReviewText || '', /上午/);
        assert.equal(dialogs.some(item => /Unexpected token|<!DOCTYPE/i.test(item.message)), false);

        await clearRecognizedConstraints();

        await clickByScript('[data-action="switch-constraint-mode"][data-mode="manual"]');
        await page.fill('#tt-manual-target', '数学');
        await page.fill('#tt-manual-time', '周一上午');
        await clickByScript('[data-action="add-manual-constraint"]');
        await page.waitForSelector('.tt-requirement-workbench', { timeout: 10000 });

        const manualReviewText = await recognizedText();
        assert.match(manualReviewText || '', /解析结果/);
        assert.match(manualReviewText || '', /来自你的输入/);
        assert.match(manualReviewText || '', /落地结果/);
        assert.match(manualReviewText || '', /手动添加/);
        assert.match(manualReviewText || '', /周一上午/);

        await clickByScript('[data-action="apply-constraints"]');
        await page.waitForFunction(() => !document.querySelector('[data-constraint-dialog-overlay]'), { timeout: 10000 });
        assert.ok(dialogs.some(item => /已写入 \d+ 条硬规则、\d+ 条软规则，更新 \d+ 个任课计划。共 1 条已生效。/.test(item.message)));

        console.log('timetable rule review smoke passed');
    });
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
