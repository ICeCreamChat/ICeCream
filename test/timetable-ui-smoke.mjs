import assert from 'node:assert/strict';

import { createDefaultTimetableProject } from '../gateway/services/timetable-project.js';
import { withOpenedTimetablePage } from './timetable-ui-smoke-helpers.mjs';

function createInspectorSmokeProject() {
    const classes = Array.from({ length: 24 }, (_, index) => ({
        id: `c${index + 1}`,
        grade: '八年级',
        name: `G8-${index + 10}班`,
    }));
    const dutyTeachers = [
        { id: 't_zhang_san', name: '张三', subjects: ['math'], unavailableSlots: [] },
        { id: 't_zhang_san_feng', name: '张三丰', subjects: ['duty'], unavailableSlots: [] },
        ...Array.from({ length: 80 }, (_, index) => ({
            id: `t_duty_${index + 1}`,
            name: `值班老师${index + 1}`,
            subjects: ['duty'],
            unavailableSlots: [],
        })),
    ];
    const slots = classes.map((klass, index) => ({
        id: `slot-${klass.id}`,
        day: (index % 5) + 1,
        period: (index % 7) + 1,
        classId: klass.id,
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: `lp-${klass.id}`,
    }));
    return createDefaultTimetableProject({
        schoolName: 'Smoke School',
        term: '2026',
        weekdays: 5,
        periodsPerDay: 7,
        teachers: [
            { id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] },
            ...dutyTeachers,
        ],
        classes,
        subjects: [
            { id: 'math', name: 'Math', priority: 90, color: '#2563eb' },
            { id: 'duty', name: '值班', priority: 10, color: '#0891b2' },
        ],
        lessonPlans: classes.map(klass => ({
            id: `lp-${klass.id}`,
            classId: klass.id,
            subjectId: 'math',
            teacherId: 't_math',
            weeklyHours: 1,
        })),
        periodTimes: [
            { period: 1, start: '08:00', end: '08:40' },
            { period: 2, start: '08:50', end: '09:30' },
            { period: 3, start: '09:40', end: '10:20' },
            { period: 4, start: '10:30', end: '11:10' },
            { period: 5, start: '14:00', end: '14:40' },
            { period: 6, start: '14:50', end: '15:30' },
            { period: 7, start: '15:40', end: '16:20' },
        ],
        periodTimeSegments: {
            globalDefaults: { classMinutes: 40, breakMinutes: 10 },
            segments: [
                { id: 'early-study', label: '早自习', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
                { id: 'morning', label: '上午', startTime: '08:00', periodCount: 7, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
            ],
        },
        rules: { hardRules: {}, softRules: {} },
        schedule: {
            id: 'smoke-inspector-heavy-review',
            generatedAt: '2026-01-02T00:00:00.000Z',
            source: 'fast_constructed',
            slots,
            lockedSlots: [],
            unplaced: [],
            conflicts: [],
            qualityIssues: classes.map((klass, index) => ({
                id: `subject-spread-${klass.id}`,
                severity: 'warning',
                type: 'subject_spread',
                message: '同科课程建议分散。',
                targetKind: 'class',
                targetId: klass.id,
                targetName: `${klass.grade}${klass.name}`,
                slot: { day: slots[index].day, period: slots[index].period },
            })),
            diagnostics: { items: [], suggestions: [] },
            score: {
                hardConflicts: 0,
                unplacedLessons: 0,
                placedLessons: slots.length,
                totalLessons: slots.length,
                completeness: 100,
            },
        },
    });
}

async function main() {
    await withOpenedTimetablePage({ port: 3137, seedProject: createInspectorSmokeProject() }, async ({ page }) => {
        const title = await page.textContent('.tool-title');
        assert.match(title || '', /智能排课/);

        const inspectorSummary = page.locator('.tt-inspector-summary');
        assert.match(await inspectorSummary.textContent(), /复核 24/);
        assert.doesNotMatch(await inspectorSummary.textContent(), /诊断 \/ 质量 \/ 发布/);

        await inspectorSummary.click();
        await page.locator('#tt-inspector-drawer[open]').waitFor({ timeout: 10000 });

        const subjectSpreadGroup = page.locator('.tt-inspector-problem-group', { hasText: '同科分散' }).first();
        await subjectSpreadGroup.waitFor({ timeout: 10000 });
        assert.equal((await subjectSpreadGroup.locator('.tt-inspector-problem-head > span').textContent())?.trim(), '24');
        assert.doesNotMatch(await page.locator('#tt-inspector-drawer').textContent(), /班级课表接近满载/);

        const targetRows = subjectSpreadGroup.locator('.tt-inspector-target-row');
        assert.equal(await targetRows.count(), 5);
        assert.ok(await subjectSpreadGroup.getByText('八年级G8-10班').isVisible());
        assert.equal(await subjectSpreadGroup.getByText('八年级G8-15班').count(), 0);

        await subjectSpreadGroup.getByRole('button', { name: /展开更多 20|展开剩余 19/ }).click();
        await page.waitForFunction(() => document.body.innerText.includes('八年级G8-33班'));
        assert.equal(await targetRows.count(), 24);

        const expandedTarget = subjectSpreadGroup.getByRole('button', { name: /定位：八年级G8-33班/ });
        await expandedTarget.scrollIntoViewIfNeeded();
        const scrollBeforeLocate = await page.locator('.tt-inspector-body').evaluate(node => node.scrollTop);
        assert.ok(scrollBeforeLocate > 0, `expected inspector body to be scrolled before locate, got ${scrollBeforeLocate}`);

        await expandedTarget.click();
        await page.locator('.is-inspector-located-source').waitFor({ timeout: 10000 });
        const scrollAfterLocate = await page.locator('.tt-inspector-body').evaluate(node => node.scrollTop);
        assert.ok(scrollAfterLocate > 0, `expected inspector body not to jump to top after locate, got ${scrollAfterLocate}`);
        await page.locator('.is-inspector-locate-pulse').first().waitFor({ timeout: 10000 });

        await page.locator('#tt-inspector-drawer[open] .tt-inspector-summary').click();
        await page.getByRole('button', { name: /未排值班/ }).first().click();
        const dutyDialog = page.locator('#tt-duty-assignment-dialog');
        await dutyDialog.waitFor({ timeout: 10000 });
        assert.equal(await dutyDialog.locator('select#tt-duty-assignment-teacher').count(), 0);
        assert.equal(await dutyDialog.locator('#tt-duty-assignment-teacher[type="hidden"]').count(), 1);
        const listBox = await dutyDialog.locator('[data-duty-teacher-list]').boundingBox();
        assert.ok(listBox && listBox.height <= 260, `expected teacher list to stay bounded, got ${listBox?.height}`);
        assert.equal(await dutyDialog.locator('[data-duty-teacher-empty="true"]').count(), 0);
        assert.doesNotMatch(await dutyDialog.locator('[data-duty-teacher-list]').textContent(), /\b[st]_[a-z0-9_-]+\b/i);

        const teacherSearch = dutyDialog.locator('[data-duty-teacher-search]');
        await teacherSearch.fill('zhangsan');
        const zhangOption = dutyDialog.locator('[data-duty-teacher-option="t_zhang_san"]');
        await zhangOption.waitFor({ timeout: 10000 });
        const zhangSanFengOption = dutyDialog.locator('[data-duty-teacher-option="t_zhang_san_feng"]');
        await zhangSanFengOption.waitFor({ timeout: 10000 });
        await teacherSearch.press('ArrowDown');
        await teacherSearch.press('Enter');
        assert.equal(await dutyDialog.locator('#tt-duty-assignment-teacher').inputValue(), 't_zhang_san_feng');
        await dutyDialog.getByRole('button', { name: /保存值班/ }).click();
        await dutyDialog.waitFor({ state: 'detached', timeout: 10000 });
        await page.getByRole('button', { name: /张三丰/ }).first().waitFor({ timeout: 10000 });

        console.log('timetable ui smoke passed');
    });
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
