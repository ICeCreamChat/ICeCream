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
        rules: {
            hardRules: {
                classUnavailable: Object.fromEntries(classes.map(klass => [klass.id, ['5-7']])),
                teacherUnavailable: Object.fromEntries(dutyTeachers.map(teacher => [teacher.id, ['1-1']])),
                lockedSlots: [],
            },
            softRules: {
                morningSubjects: ['math'],
                subjectPreferredPeriods: {
                    math: { avoid: [`${slots[0].day}-${slots[0].period}`], weight: 20 },
                },
            },
        },
        schedule: {
            id: 'smoke-inspector-heavy-review',
            generatedAt: '2026-01-02T00:00:00.000Z',
            source: 'fast_constructed',
            slots,
            lockedSlots: [],
            unplaced: [],
            conflicts: [],
            qualityIssues: classes.map((klass, index) => ({
                id: `manual-review-${klass.id}`,
                severity: 'warning',
                type: 'manual_review',
                message: '发布前请人工复核。',
                targetKind: 'class',
                targetId: klass.id,
                targetName: `${klass.grade}${klass.name}`,
                slot: { day: slots[index].day, period: slots[index].period },
            })),
            diagnostics: {
                diagnosticsVersion: 1,
                summary: { error: 0, warning: 4, info: 0, total: 4, suggestions: 4 },
                items: [
                    { id: 'diag-class-load', category: 'audit', source: 'schedule.audit.warnings', type: 'class_load', severity: 'warning', targetKind: 'class', targetId: classes[0].id, targetName: `${classes[0].grade}${classes[0].name}`, message: '班级课表接近满载。' },
                    { id: 'diag-subject-spread', category: 'quality', source: 'schedule.qualityIssues', type: 'subject_spread', severity: 'warning', targetKind: 'class', targetId: classes[1].id, targetName: `${classes[1].grade}${classes[1].name}`, message: 'Math 同一天过于集中。' },
                    { id: 'diag-morning', category: 'quality', source: 'schedule.qualityIssues', type: 'morning_subject_late', severity: 'info', targetKind: 'class', targetId: classes[2].id, targetName: `${classes[2].grade}${classes[2].name}`, message: 'Math 未排在上午优先时段。' },
                    { id: 'diag-teacher-consecutive', category: 'quality', source: 'schedule.qualityIssues', type: 'teacher_consecutive', severity: 'warning', targetKind: 'teacher', targetId: 't_math', targetName: 'Math Teacher', message: 'Math Teacher 连续授课偏多。' },
                ],
                suggestions: [
                    { id: 'sug-class-load', kind: 'audit', targetDiagnostics: ['diag-class-load'], targetKind: 'class', targetId: classes[0].id, targetName: `${classes[0].grade}${classes[0].name}`, message: `复核 ${classes[0].grade}${classes[0].name} 的相关数据。` },
                    { id: 'sug-subject-spread', kind: 'quality', targetDiagnostics: ['diag-subject-spread'], targetKind: 'class', targetId: classes[1].id, targetName: `${classes[1].grade}${classes[1].name}`, message: `复核 ${classes[1].grade}${classes[1].name} 的软规则表现，必要时调整偏好或接受当前结果。` },
                    { id: 'sug-morning', kind: 'publication', targetDiagnostics: ['diag-morning'], targetKind: 'class', targetId: classes[2].id, targetName: `${classes[2].grade}${classes[2].name}`, message: `发布前先处理 ${classes[2].grade}${classes[2].name} 的阻断项，再重新检查课表。` },
                    { id: 'sug-teacher-consecutive', kind: 'quality', targetDiagnostics: ['diag-teacher-consecutive'], targetKind: 'teacher', targetId: 't_math', targetName: 'Math Teacher', message: '复核 Math Teacher 的软规则表现，必要时调整偏好或接受当前结果。' },
                ],
            },
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

        const manualReviewGroup = page.locator('.tt-inspector-problem-group', { hasText: '教务复核' }).first();
        await manualReviewGroup.waitFor({ timeout: 10000 });
        assert.equal((await manualReviewGroup.locator('.tt-inspector-problem-head > span').textContent())?.trim(), '24');
        assert.doesNotMatch(await page.locator('#tt-inspector-drawer').textContent(), /班级课表接近满载/);
        assert.doesNotMatch(await page.locator('#tt-inspector-drawer').textContent(), /同科分散|同一天过于集中/);
        assert.doesNotMatch(await page.locator('#tt-inspector-drawer').textContent(), /教师连续课|连续授课偏多/);
        assert.doesNotMatch(await page.locator('#tt-inspector-drawer').textContent(), /主科时段|未排在上午优先时段/);
        assert.doesNotMatch(await page.locator('#tt-inspector-drawer').textContent(), /发布前先处理|软规则表现|相关数据/);

        const fulfillmentSection = page.locator('[data-inspector-section="constraint-fulfillment"]');
        await fulfillmentSection.waitFor({ timeout: 10000 });
        await page.waitForFunction(() => document.body.innerText.includes('约束 108') && document.body.innerText.includes('基于当前课表评估'));
        const fulfillmentText = await fulfillmentSection.textContent();
        assert.match(fulfillmentText || '', /约束 108/);
        assert.match(fulfillmentText || '', /未满足|部分满足/);
        assert.match(fulfillmentText || '', /Math/);
        assert.equal(await fulfillmentSection.locator('.tt-inspector-problem-group').count(), 0);
        await fulfillmentSection.locator('[data-constraint-fulfillment-filter="all"]').click();
        await page.waitForFunction(() => document.body.innerText.includes('值班老师80 教师不可排'));
        assert.ok(await fulfillmentSection.locator('[data-constraint-fulfillment-row]').count() > 20);

        const targetRows = manualReviewGroup.locator('.tt-inspector-target-row');
        assert.equal(await targetRows.count(), 5);
        assert.ok(await manualReviewGroup.getByText('八年级G8-10班').isVisible());
        assert.equal(await manualReviewGroup.getByText('八年级G8-15班').count(), 0);

        await manualReviewGroup.getByRole('button', { name: /展开更多 20|展开剩余 19/ }).click();
        await page.waitForFunction(() => document.body.innerText.includes('八年级G8-33班'));
        assert.equal(await targetRows.count(), 24);

        const expandedTarget = manualReviewGroup.getByRole('button', { name: /定位：八年级G8-33班/ });
        await expandedTarget.scrollIntoViewIfNeeded();
        const scrollBeforeLocate = await page.locator('.tt-inspector-body').evaluate(node => node.scrollTop);
        assert.ok(scrollBeforeLocate > 0, `expected inspector body to be scrolled before locate, got ${scrollBeforeLocate}`);

        await expandedTarget.click();
        await page.locator('.is-inspector-located-source').waitFor({ timeout: 10000 });
        const scrollAfterLocate = await page.locator('.tt-inspector-body').evaluate(node => node.scrollTop);
        assert.ok(scrollAfterLocate > 0, `expected inspector body not to jump to top after locate, got ${scrollAfterLocate}`);
        await page.locator('.is-inspector-locate-pulse').first().waitFor({ timeout: 10000 });

        const systemDetails = page.locator('[data-inspector-section="system"]');
        await systemDetails.scrollIntoViewIfNeeded();
        await systemDetails.locator('summary').click();
        const systemText = await systemDetails.textContent();
        assert.match(systemText || '', /数据摘要/);
        assert.match(systemText || '', /生成详情/);
        assert.doesNotMatch(systemText || '', /发布问题|排课诊断|诊断报告|质量建议|诊断明细|诊断建议/);
        assert.equal(await systemDetails.locator('.tt-inspector-problem-group').count(), 0);
        assert.equal(await systemDetails.locator('[data-action="locate-inspector-issue"]').count(), 0);

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
