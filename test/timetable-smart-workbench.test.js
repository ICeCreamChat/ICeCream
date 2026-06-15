import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildSmartDataAudit,
    createSmartWorkbenchState,
    deriveSmartWorkbenchStage,
    transitionSmartWorkbench,
} from '../public/js/tools/timetable/smart-workbench/workbench-state.js';
import {
    adaptDraftRowsForWorkbench,
    buildRuleChangePreview,
    groupWorkbenchConstraints,
} from '../public/js/tools/timetable/smart-workbench/constraint-adapter.js';
import { createRenderScheduler } from '../public/js/tools/timetable/smart-workbench/render-scheduler.js';
import { renderSmartWorkbench } from '../public/js/tools/timetable/smart-workbench/workbench-view.js';
import { createDefaultTimetableProject } from '../gateway/services/timetable-scheduler.js';

function project(overrides = {}) {
    return createDefaultTimetableProject({
        schoolName: '测试学校',
        teachers: [{ id: 't1', name: '张老师' }],
        classes: [{ id: 'c1', grade: '七年级', name: '1班' }],
        subjects: [{ id: 's1', name: '数学', priority: 90, color: '#0891b2' }],
        lessonPlans: [{
            id: 'lp1',
            classId: 'c1',
            subjectId: 's1',
            teacherId: 't1',
            weeklyHours: 4,
        }],
        rules: { hardRules: {}, softRules: {} },
        ...overrides,
    });
}

test('smart workbench state machine derives the next beginner stage from current data', () => {
    const initial = createSmartWorkbenchState();
    assert.equal(initial.stage, 'idle');
    assert.equal(deriveSmartWorkbenchStage({ project: project() }), 'ready_for_constraints');
    assert.equal(deriveSmartWorkbenchStage({
        project: project(),
        ruleReview: { loading: true, phase: 'parse_text' },
    }), 'parsing_constraints');
    assert.equal(deriveSmartWorkbenchStage({
        project: project(),
        ruleReview: { draftRows: [{ id: 'r1', status: 'needs_review' }] },
    }), 'waiting_user_confirmation');
});

test('smart workbench data audit blocks invalid roster references and zero hours', () => {
    const invalidProject = {
        ...project(),
        lessonPlans: [{
            id: 'bad-plan',
            classId: 'missing-class',
            subjectId: 's1',
            teacherId: '',
            weeklyHours: 0,
        }],
    };

    const audit = buildSmartDataAudit(invalidProject);

    assert.equal(audit.canContinue, false);
    assert.equal(audit.stats.invalidReferenceCount, 1);
    assert.equal(audit.stats.missingTeacherCount, 1);
    assert.equal(audit.stats.invalidHourCount, 1);
    assert.equal(deriveSmartWorkbenchStage({ project: invalidProject }), 'data_need_fix');
});

test('smart workbench state machine rejects invalid transitions and preserves a usable stage', () => {
    const current = createSmartWorkbenchState({ stage: 'ready_for_constraints' });
    const invalid = transitionSmartWorkbench(current, 'solution_review');
    assert.equal(invalid.stage, 'ready_for_constraints');
    assert.match(invalid.error, /不能直接进入/);

    const parsing = transitionSmartWorkbench(current, 'parsing_constraints');
    assert.equal(parsing.stage, 'parsing_constraints');
    const failed = transitionSmartWorkbench(parsing, 'failed', { error: '解析超时' });
    assert.equal(failed.stage, 'failed');
    assert.equal(failed.recoveryStage, 'ready_for_constraints');
});

test('constraint adapter produces beginner-readable models and four separate groups', () => {
    const rows = adaptDraftRowsForWorkbench([{
        id: 'ready',
        rawText: '数学尽量安排在上午',
        type: 'subject_morning',
        targetType: 'subject',
        targetId: 's1',
        targetName: '数学',
        priority: 'soft',
        confidence: 0.94,
        status: 'effective',
    }, {
        id: 'review',
        rawText: '王老师周一不要排课',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetName: '王老师',
        priority: 'hard',
        confidence: 0.62,
        status: 'needs_review',
        warnings: ['存在多个同名教师'],
    }, {
        id: 'unsupported',
        rawText: '年轻老师多上公开课',
        type: 'teacher_public_lesson',
        status: 'unsupported',
    }], {
        conflicts: [{ level: 'blocking', relatedRuleIds: ['review'], message: '与固定课冲突' }],
    });

    assert.equal(rows[0].strengthLabel, '尽量满足');
    assert.equal(rows[0].confidenceLabel, '高');
    assert.match(rows[0].understanding, /数学/);
    const groups = groupWorkbenchConstraints(rows);
    assert.equal(groups.ready.length, 1);
    assert.equal(groups.review.length, 0);
    assert.equal(groups.conflict.length, 1);
    assert.equal(groups.unsupported.length, 1);
});

test('rule change preview separates additions, updates and ignored drafts', () => {
    const preview = buildRuleChangePreview({
        currentItems: [{ id: 'subject_morning:s1', type: 'subject_morning', targetName: '数学', slots: [] }],
        nextItems: [
            { id: 'subject_morning:s1', type: 'subject_morning', targetName: '数学', slots: ['1-1'] },
            { id: 'teacher_unavailable:t1', type: 'teacher_unavailable', targetName: '张老师', slots: ['1-1'] },
        ],
        draftRows: [{ id: 'ignored', status: 'unsupported', targetName: '公开课' }],
    });
    assert.equal(preview.added.length, 1);
    assert.equal(preview.updated.length, 1);
    assert.equal(preview.removed.length, 0);
    assert.equal(preview.ignored.length, 1);
});

test('render scheduler merges repeated scopes into one frame', async () => {
    const frames = [];
    let flush;
    const scheduler = createRenderScheduler({
        scheduleFrame(callback) {
            flush = callback;
            return 1;
        },
        onFlush(scopes) {
            frames.push(scopes);
        },
    });
    scheduler.request('smart-stage');
    scheduler.request('smart-stage');
    scheduler.request('smart-assistant');
    flush();
    await Promise.resolve();
    assert.deepEqual(frames, [['smart-stage', 'smart-assistant']]);
});

test('smart workbench renders a standalone three-area beginner workflow without the old dialog', () => {
    const html = renderSmartWorkbench({
        project: project(),
        smartWorkbench: createSmartWorkbenchState({
            open: true,
            stage: 'reviewing_constraints',
        }),
        ruleReview: {
            draftRows: [{
                id: 'ready',
                rawText: '数学尽量安排在上午',
                type: 'subject_morning',
                targetType: 'subject',
                targetId: 's1',
                targetName: '数学',
                priority: 'soft',
                confidence: 0.94,
                status: 'effective',
            }],
            warnings: [],
            conflicts: [],
            unsupportedItems: [],
        },
        constraintChat: null,
        constraintScan: null,
    });

    assert.match(html, /data-smart-workbench-root/);
    assert.match(html, /tt-smart-step-rail/);
    assert.match(html, /tt-smart-stage/);
    assert.match(html, /tt-smart-insight-rail/);
    assert.match(html, /可直接应用/);
    assert.match(html, /需要确认/);
    assert.match(html, /存在冲突/);
    assert.match(html, /暂不支持/);
    assert.doesNotMatch(html, /tt-rule-review-dialog/);
    assert.doesNotMatch(html, /aria-modal="true"/);
});

test('smart workbench manual mode renders a complete beginner rule builder', () => {
    const html = renderSmartWorkbench({
        project: project(),
        smartWorkbench: createSmartWorkbenchState({
            open: true,
            stage: 'ready_for_constraints',
            sourceMode: 'manual',
        }),
        ruleReview: {
            mode: 'manual',
            draftRows: [],
        },
    });

    assert.match(html, /id="tt-manual-rule-type"/);
    assert.match(html, /id="tt-manual-rule-limit"/);
    assert.match(html, /data-manual-rule-target-type="teacher"/);
    assert.match(html, /data-manual-rule-target-type="class"/);
    assert.match(html, /data-manual-rule-target-type="subject"/);
    assert.match(html, /data-manual-rule-day/);
    assert.match(html, /data-manual-rule-period/);
    assert.match(html, /id="tt-add-manual-rule-rows"/);
});

test('smart workbench review renders ambiguity tasks and lazy advanced editing', () => {
    const base = {
        project: project(),
        smartWorkbench: createSmartWorkbenchState({
            open: true,
            stage: 'reviewing_constraints',
            selectedSection: 'review',
        }),
        ruleReview: {
            draftRows: [{
                id: 'review',
                rawText: '王老师周一不排课',
                type: 'teacher_unavailable',
                targetType: 'teacher',
                targetName: '王老师',
                priority: 'hard',
                confidence: 0.6,
                status: 'needs_review',
                warnings: ['存在多个可能匹配的教师'],
            }],
            clarifyingQuestions: [{
                id: 'teacher_question',
                targetType: 'teacher',
                targetText: '王老师',
                reason: '存在多个同名或相近教师',
                options: [{ label: '张老师', value: 't1' }],
            }],
            warnings: ['存在需要确认的教师名称'],
            conflicts: [],
            unsupportedItems: [],
            advancedOpen: false,
        },
    };
    const collapsed = renderSmartWorkbench(base);
    assert.match(collapsed, /核对需要确认/);
    assert.match(collapsed, /data-rule-clarify-question="teacher_question"/);
    assert.match(collapsed, /data-rule-clarify-input="teacher_question"/);
    assert.match(collapsed, /data-action="submit-rule-clarification"/);
    assert.doesNotMatch(collapsed, /data-rule-review-row="review"/);

    const expanded = renderSmartWorkbench({
        ...base,
        ruleReview: { ...base.ruleReview, advancedOpen: true },
    });
    assert.match(expanded, /data-rule-review-row="review"/);
    assert.match(expanded, /data-rule-review-field="type"/);
    assert.match(expanded, /data-rule-review-field="targetName"/);
    assert.match(expanded, /data-rule-review-delete-row="review"/);
});

test('smart workbench can show and manage saved constraints without returning to the legacy modal', () => {
    const savedProject = project({
        rules: {
            hardRules: {
                teacherUnavailable: { t1: ['1-1'] },
            },
            softRules: {
                morningSubjects: ['s1'],
            },
        },
    });
    const html = renderSmartWorkbench({
        project: savedProject,
        smartWorkbench: createSmartWorkbenchState({
            open: true,
            stage: 'reviewing_constraints',
            selectedSection: 'saved',
        }),
        ruleReview: { draftRows: [], warnings: [], conflicts: [] },
    });

    assert.match(html, /已生效约束/);
    assert.match(html, /data-saved-rule-delete=/);
    assert.match(html, /新增约束要求/);
    assert.doesNotMatch(html, /tt-rule-review-dialog/);
});

test('smart workbench shows human source labels instead of raw parser ids', () => {
    const html = renderSmartWorkbench({
        project: project(),
        smartWorkbench: createSmartWorkbenchState({
            open: true,
            stage: 'reviewing_constraints',
            selectedSection: 'ready',
        }),
        ruleReview: {
            draftRows: [{
                id: 'source-ai',
                rawText: '数学尽量上午',
                type: 'subject_morning',
                targetType: 'subject',
                targetId: 's1',
                targetName: '数学',
                priority: 'soft',
                confidence: 0.94,
                status: 'effective',
                source: 'ai',
            }],
            warnings: [],
            conflicts: [],
            unsupportedItems: [],
        },
        constraintChat: null,
        constraintScan: null,
    });

    assert.match(html, /来源：智能解析/);
    assert.doesNotMatch(html, /来源：ai/);
});
