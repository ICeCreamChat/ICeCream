import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createDefaultTimetableProject } from '../gateway/services/timetable-scheduler.js';
import { previewTimetableRosterText } from '../gateway/services/timetable-import.js';
import { TimetablePlannerController } from '../public/js/tools/timetable/controller.js';
import { createTimetablePlannerState } from '../public/js/tools/timetable/state.js';
import { refreshReviewStatistics } from '../public/js/tools/timetable/controller-constraint-dialog.js';
import {
  getRosterStats,
  getPublishedScheduleDiff,
  getRuleSummary,
  getSavedRuleItems,
  getSolveStatus,
  removeSavedRuleById,
} from '../public/js/tools/timetable/selectors.js';
import {
  buildManualRuleDraftRows,
  exportName,
  sampleRosterText,
} from '../public/js/tools/timetable/forms.js';
import {
  buildInspectorViewModel,
  renderWorkbench,
  renderInspector,
  renderSchedulePanel,
} from '../public/js/tools/timetable/view.js';
import {
  bindGridInteractions,
  clampInspectorPosition,
  handleTimetableEscape,
  loadInspectorPosition,
  saveInspectorPosition,
} from '../public/js/tools/timetable/grid-interactions.js';
import {
  buildDutyTeacherSearchModel,
  dutyTeacherSearchQuery,
} from '../public/js/tools/timetable/duty-teacher-search.js';
import { PRESET_TEMPLATES } from '../public/js/tools/timetable/preset-templates.js';
import {
  RULE_TYPE_LABELS,
  plannerRuleTypeLabel,
} from '../public/js/tools/timetable/constraint-status-dict.js';

const sourcePath = new URL('../public/js/tools/timetable-planner.js', import.meta.url);
const stylePath = new URL('../public/css/timetable-planner.css', import.meta.url);
const appLauncherPath = new URL('../public/js/tools/app-launcher.js', import.meta.url);
const constraintDialogStylePath = new URL('../public/css/timetable-constraint-dialog.css', import.meta.url);
const constraintDialogAdvancedStylePath = new URL('../public/css/timetable-constraint-dialog-advanced.css', import.meta.url);
const moduleRoot = new URL('../public/js/tools/timetable/', import.meta.url);

function createConstraintDialogState(overrides = {}) {
  return { open: true, ...overrides };
}

function sampleWorkbenchState(overrides = {}) {
  const smartWorkbench = overrides.smartWorkbench || {};
  const ruleReviewOverride = overrides.ruleReview || {};
  const mappedConstraintDialog = overrides.constraintDialog || {
    open: Boolean(smartWorkbench.open || ruleReviewOverride.open),
  };
  const normalizedRuleReview = {
    ...ruleReviewOverride,
    inputMode: ruleReviewOverride.inputMode || ruleReviewOverride.mode || smartWorkbench.sourceMode || 'text',
    parsing: Boolean(ruleReviewOverride.parsing ?? ruleReviewOverride.loading),
  };
  return {
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: overrides.schedule ?? null,
    }),
    viewMode: 'class',
    selectedOwnerId: 'c1',
    selectedSlotId: '',
    loading: false,
    message: '',
    lastFailure: null,
    ruleReview: normalizedRuleReview,
    smartWorkbench: { open: false },
    constraintDialog: mappedConstraintDialog,
    ...overrides,
    ruleReview: normalizedRuleReview,
    smartWorkbench: { open: false },
    constraintDialog: mappedConstraintDialog,
  };
}

function readyConstraintParseProject() {
  return createDefaultTimetableProject({
    teachers: [{ id: 'teacher-ready', name: '测试教师' }],
    classes: [{ id: 'class-ready', name: '测试班', grade: '七年级' }],
    subjects: [{ id: 'subject-ready', name: '测试学科' }],
    lessonPlans: [{
      id: 'plan-ready',
      classId: 'class-ready',
      subjectId: 'subject-ready',
      teacherId: 'teacher-ready',
      teacherIds: ['teacher-ready'],
      weeklyHours: 1,
    }],
  });
}

function inspectorSummaryMarkup(html = '') {
  return html.match(/<summary class="tt-inspector-summary"[\s\S]*?<\/summary>/)?.[0] || '';
}

function inspectorSystemMarkup(html = '') {
  const start = html.indexOf('data-inspector-section="system"');
  if (start < 0) return '';
  const slotStart = html.indexOf('class="tt-slot-inspector"', start);
  return slotStart > start ? html.slice(start, slotStart) : html.slice(start);
}

test('roster text sample covers every current import field and parses locally', () => {
  const sample = sampleRosterText();
  const lines = sample.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '年级,班级,课程,教师,周课时,连堂,教室,课程类型,课程标签,课型,资源类型');

  const preview = previewTimetableRosterText(sample, { project: {} });
  assert.equal(preview.draftRows.length, 2);
  assert.equal(preview.issues.length, 0);
  assert.equal(preview.warnings.length, 0);
  assert.deepEqual(preview.draftRows.map(row => ({
    grade: row.grade,
    className: row.className,
    subjectName: row.subjectName,
    teacherName: row.teacherName,
    weeklyHours: row.weeklyHours,
    blockPreference: row.blockPreference,
    roomName: row.roomName,
    subjectCategory: row.subjectCategory,
    subjectTags: row.subjectTags,
    activityTypes: row.activityTypes,
    requiredResourceTypes: row.requiredResourceTypes,
  })), [{
    grade: '七年级',
    className: 'G7-1班',
    subjectName: '语文',
    teacherName: '刘书涵',
    weeklyHours: 5,
    blockPreference: 'single',
    roomName: 'G7-01本班教室',
    subjectCategory: 'main',
    subjectTags: ['主科', '晨间优先'],
    activityTypes: ['普通课'],
    requiredResourceTypes: ['普通教室'],
  }, {
    grade: '七年级',
    className: 'G7-1班',
    subjectName: '物理',
    teacherName: '余思齐',
    weeklyHours: 2,
    blockPreference: 'mixed',
    roomName: '物理实验室A',
    subjectCategory: 'lab',
    subjectTags: ['实验', '功能教室'],
    activityTypes: ['实验课'],
    requiredResourceTypes: ['实验室'],
  }]);
});

function timetableApiResponse(data, { ok = true, status = ok ? 200 : 400, error = '请求失败' } = {}) {
  return {
    ok,
    status,
    headers: { get: () => 'application/json' },
    async text() {
      return JSON.stringify(ok ? { success: true, data } : { success: false, error, data });
    },
  };
}

function dutyDialogMarkup(html = '') {
  return html.match(/<section class="tt-duty-assignment-dialog"[\s\S]*?<\/section>/)?.[0] || '';
}

function requirementDetailMarkup(html = '') {
  return html.match(/<aside class="tt-requirement-detail"[\s\S]*?<\/aside>/)?.[0] || '';
}

test('timetable opens smart constraints in the constraint dialog instead of the removed workbench', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'ready_for_constraints',
    }),
    ruleReview: {
      open: true,
      step: 'input',
      mode: 'text',
      text: '',
      draftRows: [],
      warnings: [],
      conflicts: [],
      unsupportedItems: [],
    },
  }));

  assert.match(html, /data-constraint-dialog-overlay/);
  assert.match(html, /tt-constraint-dialog/);
  assert.match(html, /tt-dialog-title-icon/);
  assert.match(html, /tt-constraint-dialog-body--intake/);
  assert.match(html, /tt-constraint-intake-panel/);
  assert.match(html, /tt-constraint-mode-row/);
  assert.match(html, /tt-constraint-form-surface/);
  assert.match(html, /智能约束助手/);
  assert.match(html, /排课要求/);
  assert.match(html, /开始理解/);
  assert.match(html, /data-action="parse-constraints"/);
  assert.match(html, /placeholder="例如：张老师周一上午不排课；数学尽量安排在上午；体育避开第一节"/);
  assert.doesNotMatch(html, /常用示例/);
  assert.doesNotMatch(html, /data-action="use-example"/);
  assert.doesNotMatch(html, /tt-quick-examples/);
  assert.doesNotMatch(html, /文本、文件、手动补充会进入同一套需求理解与人工复核流程/);
  assert.doesNotMatch(html, /tt-constraint-command-row/);
  assert.doesNotMatch(html, /data-smart-workbench-root/);
  assert.doesNotMatch(html, /tt-smart-workbench/);
  assert.doesNotMatch(html, /id="tt-rule-review-dialog"/);
  assert.doesNotMatch(html, /id="tt-agent-floating"/);
});

test('timetable constraint dialog keeps mode actions in one compact footer', () => {
  const renderInput = overrides => renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'input',
      mode: 'text',
      text: '',
      fileName: '',
      draftRows: [],
      warnings: [],
      conflicts: [],
      unsupportedItems: [],
      ...overrides,
    },
  }));
  const actionTag = (html, action) => html.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))?.[0] || '';

  const textHtml = renderInput({ mode: 'text' });
  assert.match(textHtml, /tt-dialog-actions[\s\S]*取消[\s\S]*开始理解/);
  assert.match(actionTag(textHtml, 'parse-constraints'), /tt-btn--primary/);

  const fileHtml = renderInput({ mode: 'file' });
  assert.match(fileHtml, /tt-dialog-actions[\s\S]*解析文件/);
  assert.match(actionTag(fileHtml, 'parse-constraints'), /disabled/);

  const selectedFileHtml = renderInput({ mode: 'file', fileName: '约束.xlsx' });
  assert.match(selectedFileHtml, /约束\.xlsx/);
  assert.doesNotMatch(actionTag(selectedFileHtml, 'parse-constraints'), /disabled/);
  assert.match(actionTag(selectedFileHtml, 'parse-constraints'), /tt-btn--primary/);

  const manualHtml = renderInput({ mode: 'manual' });
  assert.match(manualHtml, /tt-dialog-actions[\s\S]*添加约束/);
  assert.match(actionTag(manualHtml, 'add-manual-constraint'), /tt-btn--primary/);

  const reviewHtml = renderInput({
    mode: 'text',
    step: 'review',
    text: '数学尽量上午',
    draftRows: [{
      id: 'draft-review',
      rawText: '数学尽量上午',
      type: 'subject_morning',
      targetType: 'subject',
      targetName: '数学',
      targetId: 'math',
      status: 'effective',
      priority: 'soft',
      warnings: [],
    }],
  });
  assert.match(reviewHtml, /重新理解/);
  assert.doesNotMatch(actionTag(reviewHtml, 'parse-constraints'), /tt-btn--primary/);
  assert.match(actionTag(reviewHtml, 'apply-constraints'), /tt-btn--primary/);
  assert.equal([
    actionTag(reviewHtml, 'parse-constraints'),
    actionTag(reviewHtml, 'apply-constraints'),
  ].filter(tag => /tt-btn--primary/.test(tag)).length, 1);
  assert.doesNotMatch(reviewHtml, /<small>将写入排课规则，立即参与下次排课<\/small>/);
  assert.match(actionTag(reviewHtml, 'apply-constraints'), /title="将写入排课规则，立即参与下次排课"/);

  const parsingHtml = renderInput({ mode: 'text', text: '数学尽量上午', loading: true, phaseText: '生成复核行中...' });
  assert.match(parsingHtml, /正在理解/);
  assert.match(actionTag(parsingHtml, 'parse-constraints'), /disabled/);
  assert.match(actionTag(parsingHtml, 'parse-constraints'), /tt-btn--primary/);
});

test('timetable constraint dialog renders object-first requirements as a review workbench', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      text: '数学必须连堂；未注明默认单节；高负载教师不要连续太多；未知课程第1节优先。',
      draftRows: [],
      warnings: [],
      conflicts: [],
      unsupportedItems: [],
      requirementItems: [
        {
          id: 'req_rule',
          object: { kind: 'subject', name: '语文', matchedIds: ['s1'], scope: 'explicit' },
          intent: 'preferred_periods',
          status: 'actionable',
          applyTo: 'rule',
          parameters: { slots: ['1-1'] },
          source: { rawText: '语文尽量第1节' },
          confidence: 0.92,
          aiReviewStatus: 'accepted',
          reviewEvidence: { quote: '语文尽量第1节', reason: 'AI 复审确认本地识别正确。' },
        },
        {
          id: 'req_block',
          object: { kind: 'subject', name: '数学', matchedIds: ['math'], scope: 'explicit' },
          intent: 'block_preference',
          status: 'actionable',
          applyTo: 'lesson_plan',
          parameters: { blockPreference: 'double' },
          source: { rawText: '数学必须连堂' },
          confidence: 0.91,
        },
        {
          id: 'req_load',
          object: { kind: 'derived_group', name: '高负载教师', matchedIds: ['t_math'], scope: 'derived' },
          intent: 'teacher_load_protection',
          status: 'actionable',
          applyTo: 'optimization',
          parameters: { maxConsecutive: 3 },
          source: { rawText: '高负载教师不要连续太多' },
          confidence: 0.86,
          aiReviewStatus: 'flagged',
          aiReviewWarnings: ['AI 复审提示：连续节次阈值需要人工确认。'],
          reviewEvidence: { quote: '高负载教师不要连续太多', reason: '缺少明确连续节次阈值。' },
        },
        {
          id: 'req_handled',
          object: { kind: 'global', name: '默认课时块策略', matchedIds: [], scope: 'global' },
          intent: 'default_block_policy',
          status: 'handled',
          applyTo: 'solver_policy',
          parameters: { blockPreference: 'single' },
          source: { rawText: '未注明默认单节' },
          confidence: 0.95,
        },
        {
          id: 'req_review',
          object: { kind: 'subject', name: '未知课程', matchedIds: [], scope: 'ambiguous' },
          intent: 'preferred_periods',
          status: 'needs_review',
          applyTo: 'review',
          parameters: { slots: ['1-1'] },
          source: { rawText: '未知课程第1节优先', sourceRow: 4 },
          warnings: ['未找到唯一匹配课程'],
          confidence: 0.42,
          aiReviewStatus: 'flagged',
          aiReviewWarnings: ['AI 复审提示：对象未唯一匹配，不能自动应用。'],
          reviewEvidence: { quote: '未知课程第1节优先', reason: '课程对象未匹配。' },
        },
      ],
      semanticActions: [
        { id: 'act_block', requirementId: 'req_block', kind: 'lesson_plan_patch', status: 'ready' },
        { id: 'act_load', requirementId: 'req_load', kind: 'soft_rules_patch', status: 'ready' },
      ],
      aiReview: {
        status: 'reviewed',
        flaggedCount: 1,
        appliedSuggestionCount: 0,
        warningCount: 1,
      },
    },
    constraintDialog: { open: true },
  }));

  assert.match(html, /tt-constraint-dialog--semantic-review/);
  assert.match(html, /tt-requirement-workbench/);
  assert.match(html, /tt-constraint-flow/);
  assert.match(html, /输入需求[\s\S]*智能理解[\s\S]*人工复核[\s\S]*应用到项目/);
  assert.match(html, /把自然语言排课需求转换为可复核、可应用的规则和模型设置/);
  assert.match(html, /tt-requirement-review-summary/);
  assert.match(html, /当前筛选可应用 2 项/);
  assert.match(html, /tt-requirement-filter-bar/);
  assert.match(html, /tt-requirement-filter--all/);
  assert.match(html, /tt-requirement-filter-children/);
  assert.match(html, /tt-requirement-filter-children-label[\s\S]*分类/);
  assert.match(html, /tt-requirement-filter--child/);
  assert.match(html, /tt-requirement-filter-icon" data-lucide="list-filter"/);
  assert.match(html, /tt-requirement-filter-entry[\s\S]*data-lucide="door-open"/);
  assert.doesNotMatch(html, /tt-requirement-filter-entry[\s\S]{0,160}<em>/);
  assert.match(html, /tt-requirement-table/);
  assert.match(html, /tt-requirement-detail/);
  assert.doesNotMatch(html, /tt-requirement-card/);
  assert.match(html, /可应用到约束规则/);
  assert.match(html, /可应用到任课计划/);
  assert.match(html, /可应用到优化目标/);
  assert.match(html, /已自动处理/);
  assert.match(html, /需复核/);
  assert.match(html, /全部[\s\S]*5/);
  assert.match(html, /data-action="filter-requirements"/);
  assert.match(html, /data-action="select-requirement"/);
  assert.match(html, /<span>数学<\/span>/);
  assert.match(html, /<span>连堂设置<\/span>/);
  assert.match(html, /<span>高负载教师<\/span>/);
  assert.match(html, /AI 复审提示/);
  assert.match(html, /对象未唯一匹配/);
  assert.match(html, /未知课程第1节优先/);
  assert.match(html, /默认课时块策略/);
  assert.match(html, /未找到唯一匹配课程/);
  assert.match(html, /待补充信息/);
  assert.match(html, /将应用的规则/);
  assert.match(html, /任课计划|优化策略|规则草稿/);
  assert.match(html, /data-requirement-id="req_review"[\s\S]*is-selected/);
  assert.match(html, /应用需求 \(2\)/);
  assert.doesNotMatch(html, /暂不支持[\s\S]{0,80}默认单节/);
});

test('timetable constraint dialog renders AI review as lightweight detail copy', async () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      inputMode: 'text',
      draftRows: [],
      warnings: [],
      conflicts: [],
      unsupportedItems: [],
      requirementItems: [{
        id: 'req_ai_review_copy',
        object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
        intent: 'teacher_unavailable',
        status: 'actionable',
        applyTo: 'rule',
        parameters: { slots: ['1-2'] },
        source: { rawText: '刘书涵老师周一第2节不要排课。' },
        confidence: 0.95,
        aiReviewStatus: 'accepted',
        reviewEvidence: {
          quote: '刘书涵老师周一第2节不要排课。',
          reason: 'AI 已复审：需求明确，本地解析正确，生成了合理的teacher_unavailable规则。',
        },
      }],
      semanticActions: [],
      aiReview: { status: 'reviewed' },
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_ai_review_copy' },
  }));
  const dialogStyles = await readFile(constraintDialogStylePath, 'utf8');
  const aiReviewBlock = html.match(/<div class="tt-requirement-ai-review[\s\S]*?<\/div>/)?.[0] || '';

  assert.match(aiReviewBlock, /tt-requirement-ai-review--info/);
  assert.match(aiReviewBlock, /AI 已理解/);
  assert.match(aiReviewBlock, /AI 已复审/);
  assert.match(aiReviewBlock, /教师不可排规则/);
  assert.doesNotMatch(aiReviewBlock, /tt-constraint-info|tt-constraint-warning/);
  assert.doesNotMatch(aiReviewBlock, /teacher_unavailable/);
  assert.match(dialogStyles, /\.tt-requirement-ai-review\s*{[\s\S]*font-size:\s*0\.76rem;[\s\S]*font-weight:\s*400;[\s\S]*line-height:\s*1\.55;/);
  assert.match(dialogStyles, /\.tt-requirement-ai-review--info\s*{[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--tt-primary\)\s*5%,\s*var\(--tt-bg-elevated\)\)/);
  assert.match(dialogStyles, /\.tt-requirement-ai-review--warning\s*{/);
  assert.match(dialogStyles, /\.tt-requirement-ai-review p\s*{[\s\S]*color:\s*var\(--tt-text-secondary\);[\s\S]*font-weight:\s*400;/);
  assert.match(dialogStyles, /\.tt-requirement-ai-review small\s*{[\s\S]*color:\s*var\(--tt-muted\);[\s\S]*font-weight:\s*400;/);
  assert.match(html, /tt-requirement-detail-summary[\s\S]*刘书涵[\s\S]*教师不可排[\s\S]*周一第2节[\s\S]*置信度 95%/);
  assert.match(html, /将应用的规则[\s\S]*识别依据/);
  assert.match(html, /tt-requirement-detail-evidence[\s\S]*AI 已复审/);
  assert.match(html, /tt-requirement-detail-evidence[\s\S]*刘书涵老师周一第2节不要排课/);
  assert.doesNotMatch(html, /原文与相关理解|tt-requirement-detail-disclosure/);
});

test('timetable constraint dialog coalesces one natural-language rule into one review row', async () => {
  const rawText = '刘书涵老师周一第2节要参加语文备课组集体备课，这节不要给他安排课。';
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      inputMode: 'text',
      draftRows: [{
        id: 'rule-liu-unavailable',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 't_liu',
        targetName: '刘书涵',
        slots: ['1-2'],
        priority: 'hard',
        status: 'effective',
        confidence: 0.95,
        sourceText: rawText,
        parseSource: 'ai',
        origin: 'user_input',
      }],
      requirementItems: [
        {
          id: 'req_raw_need',
          origin: 'user_input',
          object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
          intent: 'schedule_request',
          status: 'needs_review',
          applyTo: 'rule',
          parameters: {},
          source: { rawText },
          confidence: 0.9,
        },
        {
          id: 'req_unavailable_time',
          origin: 'user_input',
          object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
          intent: 'unavailable_periods',
          status: 'actionable',
          applyTo: 'rule',
          parameters: { slots: ['1-2'] },
          source: { rawText },
          confidence: 0.92,
        },
      ],
      semanticActions: [],
      warnings: [],
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_unavailable_time' },
  }));
  const constraintStyles = await readFile(constraintDialogStylePath, 'utf8');
  const requirementRows = html.match(/<button data-action="select-requirement"[\s\S]*?<\/button>/g) || [];
  const detailHtml = requirementDetailMarkup(html);

  assert.equal(requirementRows.length, 1);
  assert.match(requirementRows[0], /刘书涵/);
  assert.match(requirementRows[0], /教师不可排/);
  assert.match(requirementRows[0], /周一第2节/);
  assert.doesNotMatch(requirementRows[0], /排课需求|不可排时间/);
  assert.match(html, /来自你的输入 1 条/);
  assert.match(html, /当前筛选可应用 1 项/);
  assert.match(html, /应用需求 \(1\)/);
  assert.doesNotMatch(detailHtml, /相关理解|排课需求|不可排时间/);
  assert.match(detailHtml, /识别依据[\s\S]*刘书涵老师周一第2节/);
  assert.match(html, /将应用的规则[\s\S]*规则草稿/);
  assert.doesNotMatch(html, /<details class="tt-requirement-detail-disclosure">[\s\S]*<summary>原文与相关理解<\/summary>/);
  assert.doesNotMatch(constraintStyles, /\.tt-requirement-params,\s*\.tt-requirement-related,\s*\.tt-requirement-raw\s*{/s);
  assert.doesNotMatch(constraintStyles, /\.tt-requirement-params > div,\s*\.tt-requirement-related > div\s*{/s);
  assert.match(constraintStyles, /\.tt-requirement-detail-summary\s*{/);
  assert.doesNotMatch(constraintStyles, /\.tt-requirement-detail-disclosure\s*{/);
});

test('timetable constraint dialog coalesces full-sentence understanding with a shortened machine rule', () => {
  const fullText = '刘书涵老师周一第2节要参加语文备课组集体备课，这节不要给他安排课。';
  const shortText = '刘书涵老师周一第2节不要排课';
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      inputMode: 'text',
      draftRows: [{
        id: 'rule-liu-short-unavailable',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 't_liu',
        targetName: '刘书涵',
        slots: ['1-2'],
        priority: 'hard',
        status: 'effective',
        confidence: 0.95,
        rawText: shortText,
        parseSource: 'ai',
      }],
      requirementItems: [{
        id: 'req_full_need',
        object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
        intent: 'schedule_request',
        status: 'needs_review',
        applyTo: 'review',
        parameters: {},
        source: { rawText: fullText },
        confidence: 0.9,
      }],
      semanticActions: [],
      warnings: [],
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_full_need' },
  }));
  const requirementRows = html.match(/<button data-action="select-requirement"[\s\S]*?<\/button>/g) || [];
  const detailHtml = requirementDetailMarkup(html);

  assert.equal(requirementRows.length, 1);
  assert.match(requirementRows[0], /刘书涵/);
  assert.match(requirementRows[0], /教师不可排/);
  assert.match(requirementRows[0], /周一第2节/);
  assert.doesNotMatch(requirementRows[0], /排课需求/);
  assert.match(html, /全部[\s\S]*1/);
  assert.match(html, /当前筛选可应用 1 项/);
  assert.match(html, /应用需求 \(1\)/);
  assert.doesNotMatch(detailHtml, /相关理解|排课需求/);
  assert.match(detailHtml, /识别依据[\s\S]*刘书涵老师周一第2节/);
});

test('timetable constraint dialog coalesces schedule request shells with time parameters into matching rules', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      inputMode: 'text',
      draftRows: [{
        id: 'rule-liu-time-param',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 't_liu',
        targetName: '刘书涵',
        slots: ['1-2'],
        priority: 'hard',
        status: 'effective',
        confidence: 0.95,
        rawText: '刘书涵老师周一第2节不要排课',
        parseSource: 'ai',
      }],
      requirementItems: [{
        id: 'req_time_param_shell',
        object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
        intent: 'schedule_request',
        status: 'needs_review',
        applyTo: 'review',
        parameters: { time: '周一第2节' },
        source: { channel: 'user_input', label: '我的输入' },
        confidence: 0.8,
      }],
      semanticActions: [],
      warnings: [],
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_time_param_shell' },
  }));
  const requirementRows = html.match(/<button data-action="select-requirement"[\s\S]*?<\/button>/g) || [];
  const detailHtml = requirementDetailMarkup(html);

  assert.equal(requirementRows.length, 1);
  assert.match(requirementRows[0], /刘书涵/);
  assert.match(requirementRows[0], /教师不可排/);
  assert.match(requirementRows[0], /周一第2节/);
  assert.doesNotMatch(requirementRows[0], /排课需求/);
  assert.doesNotMatch(detailHtml, /相关理解|排课需求/);
  assert.match(html, /当前筛选可应用 1 项/);
  assert.match(html, /应用需求 \(1\)/);
});

test('timetable constraint dialog coalesces schedule request shells with source text parameters into matching rules', () => {
  const rawText = '刘书涵老师周一第2节要参加语文备课组集体备课，这节不要给他安排课。';
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      inputMode: 'text',
      draftRows: [{
        id: 'rule-liu-parameter-text',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 't_liu',
        targetName: '刘书涵',
        slots: ['1-2'],
        priority: 'hard',
        status: 'effective',
        confidence: 0.95,
        rawText: '刘书涵老师周一第2节不要排课',
        parseSource: 'ai',
      }],
      requirementItems: [{
        id: 'req_parameter_text_shell',
        object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
        intent: 'schedule_request',
        status: 'needs_review',
        applyTo: 'review',
        parameters: { rawText },
        source: { channel: 'user_input', label: '我的输入' },
        confidence: 0.8,
      }],
      semanticActions: [],
      warnings: [],
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_parameter_text_shell' },
  }));
  const requirementRows = html.match(/<button data-action="select-requirement"[\s\S]*?<\/button>/g) || [];
  const detailHtml = requirementDetailMarkup(html);

  assert.equal(requirementRows.length, 1);
  assert.match(requirementRows[0], /刘书涵/);
  assert.match(requirementRows[0], /教师不可排/);
  assert.match(requirementRows[0], /周一第2节/);
  assert.doesNotMatch(requirementRows[0], /排课需求/);
  assert.doesNotMatch(detailHtml, /相关理解|排课需求/);
  assert.match(detailHtml, /识别依据[\s\S]*刘书涵老师周一第2节/);
  assert.match(html, /当前筛选可应用 1 项/);
  assert.match(html, /应用需求 \(1\)/);
});

test('timetable constraint dialog drops generic empty schedule request shells when a rule exists', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      inputMode: 'text',
      draftRows: [{
        id: 'rule-liu-unavailable-from-ai',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 't_liu',
        targetName: '刘书涵',
        slots: ['1-2'],
        priority: 'hard',
        status: 'effective',
        confidence: 0.95,
        rawText: '刘书涵周一第2节参加语文备课组集体备课',
        parseSource: 'ai',
      }],
      requirementItems: [{
        id: 'req_empty_schedule_shell',
        object: { kind: 'global', name: '全局', matchedIds: [], scope: 'derived' },
        intent: 'schedule_request',
        status: 'needs_review',
        applyTo: 'rule',
        parameters: {},
        source: { channel: 'user_input' },
        confidence: 0.7,
      }],
      semanticActions: [],
      warnings: [],
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_empty_schedule_shell' },
  }));
  const requirementRows = html.match(/<button data-action="select-requirement"[\s\S]*?<\/button>/g) || [];

  assert.equal(requirementRows.length, 1);
  assert.match(requirementRows[0], /刘书涵/);
  assert.match(requirementRows[0], /教师不可排/);
  assert.match(requirementRows[0], /周一第2节/);
  assert.doesNotMatch(requirementRows[0], /排课需求|全局/);
  assert.match(html, /全部[\s\S]*1/);
  assert.match(html, /需复核[\s\S]*0/);
  assert.match(html, /当前筛选可应用 1 项/);
  assert.match(html, /应用需求 \(1\)/);
});

test('timetable constraint dialog drops named empty schedule request shells when a rule exists', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      inputMode: 'text',
      draftRows: [{
        id: 'rule-liu-named-shell',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 't_liu',
        targetName: '刘书涵',
        slots: ['1-2'],
        priority: 'hard',
        status: 'effective',
        confidence: 0.95,
        rawText: '刘书涵周一第2节参加语文备课组集体备课',
        parseSource: 'ai',
      }],
      requirementItems: [{
        id: 'req_named_empty_schedule_shell',
        object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
        intent: 'schedule_request',
        status: 'needs_review',
        applyTo: 'rule',
        parameters: {},
        source: { channel: 'user_input' },
        confidence: 0.7,
      }],
      semanticActions: [],
      warnings: [],
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_named_empty_schedule_shell' },
  }));
  const requirementRows = html.match(/<button data-action="select-requirement"[\s\S]*?<\/button>/g) || [];

  assert.equal(requirementRows.length, 1);
  assert.match(requirementRows[0], /刘书涵/);
  assert.match(requirementRows[0], /教师不可排/);
  assert.match(requirementRows[0], /周一第2节/);
  assert.doesNotMatch(requirementRows[0], /排课需求/);
  assert.match(html, /全部[\s\S]*1/);
  assert.match(html, /需复核[\s\S]*0/);
  assert.match(html, /当前筛选可应用 1 项/);
  assert.match(html, /应用需求 \(1\)/);
});

test('timetable constraint dialog drops named placeholder-only schedule request shells when a rule exists', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      inputMode: 'text',
      draftRows: [{
        id: 'rule-liu-placeholder-shell',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 't_liu',
        targetName: '刘书涵',
        slots: ['1-2'],
        priority: 'hard',
        status: 'effective',
        confidence: 0.95,
        rawText: '刘书涵老师周一第2节不要排课',
        parseSource: 'ai',
      }],
      requirementItems: [{
        id: 'req_named_placeholder_shell',
        object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
        intent: 'schedule_request',
        status: 'needs_review',
        applyTo: 'rule',
        parameters: {
          teacherName: '刘书涵',
          type: 'teacher_unavailable',
          time: '-',
          destination: '排课规则',
        },
        source: { channel: 'user_input', label: '我的输入' },
        reviewEvidence: {
          reason: 'AI 已复审：这是上层排课需求理解，实际落地为教师不可排规则。',
        },
        confidence: 0.7,
      }],
      semanticActions: [],
      warnings: [],
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_named_placeholder_shell' },
  }));
  const requirementRows = html.match(/<button data-action="select-requirement"[\s\S]*?<\/button>/g) || [];

  assert.equal(requirementRows.length, 1);
  assert.match(requirementRows[0], /刘书涵/);
  assert.match(requirementRows[0], /教师不可排/);
  assert.match(requirementRows[0], /周一第2节/);
  assert.doesNotMatch(requirementRows[0], /排课需求/);
  assert.match(html, /全部[\s\S]*1/);
  assert.match(html, /需复核[\s\S]*0/);
  assert.match(html, /当前筛选可应用 1 项/);
  assert.match(html, /应用需求 \(1\)/);
});

test('timetable constraint dialog hides covered redundant review hints from merged rule details', () => {
  const rawText = '刘书涵老师周一第2节要参加语文备课组集体备课，这节不要给他安排课。';
  const redundantMessage = '冗余需求：缺少具体时段参数，已被req_rule_draft_1覆盖';
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      inputMode: 'text',
      draftRows: [{
        id: 'req_rule_draft_1',
        requirementId: 'req_redundant_shell',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 't_liu',
        targetName: '刘书涵',
        slots: ['1-2'],
        priority: 'hard',
        status: 'effective',
        confidence: 0.95,
        rawText,
        parseSource: 'ai',
        aiReviewStatus: 'accepted',
        reviewEvidence: {
          quote: rawText,
          reason: '需求已正确解析为教师不可用时段规则',
        },
      }],
      requirementItems: [{
        id: 'req_redundant_shell',
        object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
        intent: 'schedule_request',
        status: 'needs_review',
        applyTo: 'review',
        parameters: {},
        source: { rawText: redundantMessage, channel: 'user_input', label: '我的输入' },
        aiReviewStatus: 'accepted',
        reviewEvidence: {
          quote: rawText,
          reason: '需求已正确解析为教师不可用时段规则',
        },
        warnings: [redundantMessage],
        clarification: {
          field: 'slots',
          kind: 'text',
          question: redundantMessage,
        },
        confidence: 0.7,
      }],
      semanticActions: [],
      warnings: [],
      aiReview: { status: 'reviewed' },
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_redundant_shell' },
  }));
  const requirementRows = html.match(/<button data-action="select-requirement"[\s\S]*?<\/button>/g) || [];

  assert.equal(requirementRows.length, 1);
  assert.match(requirementRows[0], /刘书涵/);
  assert.match(requirementRows[0], /教师不可排/);
  assert.match(requirementRows[0], /周一第2节/);
  assert.match(html, /AI 已理解/);
  assert.match(html, /需求已正确解析为教师不可用时段规则/);
  assert.doesNotMatch(html, /待补充信息/);
  assert.doesNotMatch(html, /冗余需求/);
  assert.match(html, /当前筛选可应用 1 项/);
  assert.match(html, /应用需求 \(1\)/);
});

test('timetable constraint dialog keeps meaningful review requirements with clarification', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      inputMode: 'text',
      draftRows: [],
      requirementItems: [{
        id: 'req_meaningful_review',
        object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
        intent: 'schedule_request',
        status: 'needs_review',
        applyTo: 'review',
        parameters: {},
        source: { channel: 'user_input' },
        clarification: {
          field: 'slots',
          kind: 'text',
          question: '请补充刘书涵老师不可排的具体节次。',
        },
        confidence: 0.7,
      }],
      semanticActions: [],
      warnings: [],
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_meaningful_review' },
  }));
  const requirementRows = html.match(/<button data-action="select-requirement"[\s\S]*?<\/button>/g) || [];

  assert.equal(requirementRows.length, 1);
  assert.match(requirementRows[0], /刘书涵/);
  assert.match(requirementRows[0], /排课需求/);
  assert.match(html, /待补充信息/);
  assert.match(html, /请补充刘书涵老师不可排的具体节次/);
  assert.match(html, /全部[\s\S]*1/);
  assert.match(html, /需复核[\s\S]*1/);
});

test('timetable constraint dialog keeps separate same-teacher demands at different periods', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      inputMode: 'text',
      draftRows: [
        {
          id: 'rule-liu-monday-second',
          type: 'teacher_unavailable',
          targetType: 'teacher',
          targetId: 't_liu',
          targetName: '刘书涵',
          slots: ['1-2'],
          priority: 'hard',
          status: 'effective',
          rawText: '刘书涵老师周一第2节不要排课',
        },
        {
          id: 'rule-liu-tuesday-third',
          type: 'teacher_unavailable',
          targetType: 'teacher',
          targetId: 't_liu',
          targetName: '刘书涵',
          slots: ['2-3'],
          priority: 'hard',
          status: 'effective',
          rawText: '刘书涵老师周二第3节不要排课',
        },
      ],
      requirementItems: [
        {
          id: 'req_monday_second',
          object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
          intent: 'schedule_request',
          status: 'needs_review',
          applyTo: 'review',
          source: { rawText: '刘书涵老师周一第2节不要排课' },
        },
        {
          id: 'req_tuesday_third',
          object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
          intent: 'schedule_request',
          status: 'needs_review',
          applyTo: 'review',
          source: { rawText: '刘书涵老师周二第3节不要排课' },
        },
      ],
      semanticActions: [],
      warnings: [],
    },
    constraintDialog: { open: true },
  }));
  const requirementRows = html.match(/<button data-action="select-requirement"[\s\S]*?<\/button>/g) || [];

  assert.equal(requirementRows.length, 2);
  assert.match(requirementRows[0] + requirementRows[1], /周一第2节/);
  assert.match(requirementRows[0] + requirementRows[1], /周二第3节/);
  assert.match(html, /当前筛选可应用 2 项/);
  assert.match(html, /应用需求 \(2\)/);
});

test('timetable constraint dialog groups one demand with multiple same-slot machine rules', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      inputMode: 'text',
      draftRows: [
        {
          id: 'rule-liu-group',
          type: 'teacher_unavailable',
          targetType: 'teacher',
          targetId: 't_liu',
          targetName: '刘书涵',
          slots: ['1-2'],
          priority: 'hard',
          status: 'effective',
          rawText: '刘书涵和张老师周一第2节都不要排课',
        },
        {
          id: 'rule-zhang-group',
          type: 'teacher_unavailable',
          targetType: 'teacher',
          targetId: 't_zhang',
          targetName: '张老师',
          slots: ['1-2'],
          priority: 'hard',
          status: 'effective',
          rawText: '刘书涵和张老师周一第2节都不要排课',
        },
      ],
      requirementItems: [{
        id: 'req_group_unavailable',
        object: { kind: 'teacher_group', name: '刘书涵、张老师', matchedIds: ['t_liu', 't_zhang'], scope: 'explicit' },
        intent: 'schedule_request',
        status: 'needs_review',
        applyTo: 'review',
        source: { rawText: '刘书涵和张老师周一第2节都不要排课' },
      }],
      semanticActions: [],
      warnings: [],
    },
    constraintDialog: { open: true },
  }));
  const requirementRows = html.match(/<button data-action="select-requirement"[\s\S]*?<\/button>/g) || [];

  assert.equal(requirementRows.length, 1);
  assert.match(requirementRows[0], /教师不可排/);
  assert.match(requirementRows[0], /周一第2节/);
  assert.match(html, /当前筛选可应用 1 项/);
  assert.match(html, /应用需求 \(1\)/);
});

test('timetable constraint dialog does not count rules_patch bridge actions as extra machine rules', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      draftRows: [{
        id: 'rule-row',
        requirementId: 'req_rule',
        rawText: '语文尽量上午前四节',
        type: 'subject_preferred_periods',
        targetType: 'subject',
        targetName: '语文',
        slots: ['1-1', '1-2', '1-3', '1-4'],
        priority: 'soft',
        status: 'effective',
      }],
      requirementItems: [{
        id: 'req_rule',
        object: { kind: 'subject', name: '语文', matchedIds: ['s1'], scope: 'explicit' },
        intent: 'preferred_periods',
        status: 'actionable',
        applyTo: 'rule',
        parameters: { slots: ['1-1', '1-2', '1-3', '1-4'] },
        source: { rawText: '语文尽量上午前四节', sourceRow: 2 },
      }],
      semanticActions: [{
        id: 'act_rule',
        requirementId: 'req_rule',
        kind: 'rules_patch',
        status: 'ready',
        target: { rowIds: ['rule-row'] },
      }],
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_rule' },
  }));

  assert.match(html, /将应用的规则[\s\S]{0,80}1 项/);
  assert.match(html, /data-constraint-id="rule-row"/);
  assert.doesNotMatch(html, /约束规则补丁/);
});

test('timetable constraint dialog keeps requirement detail source aligned with its machine rule', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'xlsx',
      draftRows: [{
        id: 'subject-rule-row',
        requirementId: 'req_subject_prefer',
        rawText: '语文尽量安排在上午前四节',
        type: 'subject_preferred_periods',
        targetType: 'subject',
        targetName: '语文',
        slots: ['1-1', '1-2', '1-3', '1-4'],
        priority: 'soft',
        status: 'effective',
        sourceSheet: 'AI约束建议',
        sourceRow: 2,
        parseSource: 'local_xlsx',
      }],
      requirementItems: [{
        id: 'req_subject_prefer',
        rowId: 'subject-rule-row',
        object: { kind: 'subject', name: '语文', matchedIds: ['s1'], scope: 'explicit' },
        intent: 'preferred_periods',
        status: 'actionable',
        applyTo: 'rule',
        parameters: { slots: ['1-1', '1-2', '1-3', '1-4'] },
        source: {
          rawText: '同一位教师同一时间只能给一个班上课。',
          sourceSheet: '基础规则',
          sourceRow: 1,
          parseSource: 'ai',
        },
      }],
      semanticActions: [{
        id: 'act_subject_prefer',
        requirementId: 'req_subject_prefer',
        kind: 'rules_patch',
        status: 'ready',
        target: { rowIds: ['subject-rule-row'] },
      }],
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_subject_prefer' },
  }));

  assert.match(html, /<span>语文<\/span>/);
  assert.match(html, /<strong>语文<\/strong>/);
  assert.match(html, /原文[\s\S]{0,160}语文尽量安排在上午前四节/);
  assert.match(html, /来源[\s\S]{0,120}AI约束建议 第 2 行/);
  assert.doesNotMatch(html, /原文[\s\S]{0,160}同一位教师同一时间只能给一个班上课/);
});

test('timetable constraint dialog localizes semantic enum aliases in requirement review', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      draftRows: [],
      warnings: [],
      conflicts: [],
      unsupportedItems: [],
      requirementItems: [
        {
          id: 'req_candidate_morning',
          object: { kind: 'subject', name: '语文', matchedIds: ['s1'], scope: 'explicit' },
          intent: 'morning_preference',
          status: 'candidate',
          applyTo: 'rule',
          parameters: { dayPart: 'morning' },
          source: { rawText: '语文尽量上午' },
          confidence: 0.84,
        },
        {
          id: 'req_candidate_spread',
          object: { kind: 'subject', name: '英语', matchedIds: ['s3'], scope: 'explicit' },
          intent: 'spread',
          status: 'candidate',
          applyTo: 'lesson_plan',
          parameters: { blockPreference: 'double' },
          source: { rawText: '如果生成了连堂块' },
          confidence: 0.78,
        },
        {
          id: 'req_old_morning',
          object: { kind: 'subject', name: '数学', matchedIds: ['s2'], scope: 'explicit' },
          intent: 'subject_morning',
          status: 'candidate',
          applyTo: 'lesson_plan',
          parameters: {},
          source: { rawText: '数学尽量上午' },
          confidence: 0.9,
        },
        {
          id: 'req_old_avoid',
          object: { kind: 'subject', name: '体育', matchedIds: ['s4'], scope: 'explicit' },
          intent: 'subject_avoid_periods',
          status: 'suggestion',
          applyTo: 'constraint_rule',
          parameters: { periods: [1] },
          source: { rawText: '体育第一节不要排' },
          confidence: 0.82,
        },
        {
          id: 'req_old_teacher_time',
          object: { kind: 'teacher', name: '张老师', matchedIds: ['t1'], scope: 'explicit' },
          intent: 'teacher_unavailable',
          status: 'ready',
          applyTo: 'rule',
          parameters: { slots: ['1-1'] },
          source: { rawText: '张老师周一第一节不排' },
          confidence: 0.91,
        },
      ],
      semanticActions: [],
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_candidate_morning' },
  }));

  assert.match(html, /待确认/);
  assert.match(html, /上午优先/);
  assert.match(html, /课程分散/);
  assert.match(html, /避开节次/);
  assert.match(html, /教师不可排/);
  assert.match(html, /双连堂/);
  assert.match(requirementDetailMarkup(html), /识别依据[\s\S]*语文尽量上午/);
  assert.match(html, /建议/);
  assert.doesNotMatch(html, />candidate</);
  assert.doesNotMatch(html, />morning_preference</);
  assert.doesNotMatch(html, />spread</);
  assert.doesNotMatch(html, /subject_morning/);
  assert.doesNotMatch(html, /subject_avoid_periods/);
  assert.doesNotMatch(html, /teacher_unavailable/);
  assert.doesNotMatch(html, /blockPreference/);
  assert.doesNotMatch(html, /：double|>double</);
});

test('constraint dialog renders requirement clarification and submits structured answer', async () => {
  const ruleReview = {
    open: true,
    mode: 'text',
    inputMode: 'text',
    draftRows: [],
    warnings: [],
    conflicts: [],
    unsupportedItems: [],
    requirementItems: [{
      id: 'req_high_load',
      object: { kind: 'derived_group', name: '高负载教师', matchedIds: ['t_math'], scope: 'derived' },
      intent: 'teacher_load_protection',
      status: 'needs_review',
      applyTo: 'optimization',
      parameters: { balancedTeacherLoad: true },
      source: { rawText: '高负载教师不要连续太多' },
      clarification: {
        id: 'clarify_req_high_load_max_consecutive',
        kind: 'number',
        field: 'maxConsecutive',
        question: '连续超过几节算太多？',
        defaultValue: 3,
        min: 1,
        max: 8,
      },
    }],
    semanticActions: [],
  };
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview,
    constraintDialog: { open: true, selectedRequirementId: 'req_high_load' },
  }));

  assert.match(html, /待补充信息/);
  assert.match(html, /连续超过几节算太多/);
  assert.match(html, /data-action="submit-requirement-clarification"/);
  assert.match(html, /data-requirement-clarify-input="req_high_load"/);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    assert.equal(String(url).endsWith('/requirements/clarify'), true);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          success: true,
          data: {
            draftRows: [],
            requirementItems: [{
              ...ruleReview.requirementItems[0],
              status: 'actionable',
              parameters: { balancedTeacherLoad: true, maxConsecutive: 2 },
              clarification: null,
            }],
            semanticActions: [{
              id: 'act_high_load',
              requirementId: 'req_high_load',
              kind: 'soft_rules_patch',
              status: 'ready',
              patch: { teacherLimits: { consecutive: 2 }, balancedTeacherLoad: true },
            }],
          },
        });
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.setMessage = message => {
      controller.state.message = message;
    };
    controller.state.project = createDefaultTimetableProject();
    controller.state.ruleReview = JSON.parse(JSON.stringify(ruleReview));
    controller.state.constraintDialog = { open: true, selectedRequirementId: 'req_high_load' };
    controller.state.container = {
      querySelector(selector) {
        if (selector === '[data-requirement-clarify-input="req_high_load"]') return { value: '2' };
        return null;
      },
    };

    await controller.submitRequirementClarification('req_high_load');

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.answers, [{ requirementId: 'req_high_load', field: 'maxConsecutive', value: 2 }]);
    assert.equal(controller.state.ruleReview.requirementItems[0].status, 'actionable');
    assert.equal(controller.state.ruleReview.semanticActions[0].id, 'act_high_load');
    assert.match(controller.state.message, /已更新/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('constraint dialog maps source card clarification to legacy requirement identity and preserves source review fields', async () => {
  const clause = {
    id: 'req_test',
    requirementId: 'req_test',
    sourceId: 'src:test',
    clauseId: 'src:test:clause:1',
    object: { kind: 'teacher', name: '张老师', matchedIds: ['t1'], scope: 'explicit' },
    intent: 'teacher_daily_limit',
    status: 'needs_review',
    reviewStatus: 'needs_clarification',
    applyTo: 'review',
    source: { sourceId: 'src:test', rawText: '张老师每天不要排太多课。' },
    clarification: {
      id: 'clarify_req_test_max_daily',
      kind: 'number',
      field: 'maxDaily',
      question: '每天最多几节？',
      defaultValue: 4,
    },
  };
  const ruleReview = {
    schemaVersion: 'timetable_constraints/v2',
    sourceRequirements: [{
      sourceId: 'src:test',
      textHash: 'hash-test',
      rawText: '张老师每天不要排太多课。',
      origin: 'user_input',
      parsedBy: ['local'],
      reviewStatus: 'needs_clarification',
      clauses: [clause],
    }],
    systemSupplements: [],
    manualRequirements: [],
    constraintIRs: [clause],
    statistics: { userInputCount: 1, clauseCount: 1, executableMachineRuleCount: 0, needsReviewCount: 1 },
    warningItems: [],
    draftRows: [],
    requirementItems: [clause],
    semanticActions: [],
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          success: true,
          data: {
            ...ruleReview,
            constraintIRs: [{ ...clause, executionStatus: 'compiled' }],
            statistics: { ...ruleReview.statistics, executableMachineRuleCount: 1, needsReviewCount: 0 },
            sourceRequirements: [{
              ...ruleReview.sourceRequirements[0],
              reviewStatus: 'actionable',
              clauses: [{ ...clause, status: 'actionable', reviewStatus: 'actionable', clarification: null }],
            }],
            requirementItems: [{ ...clause, status: 'actionable', reviewStatus: 'actionable', clarification: null }],
          },
        });
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.state.project = createDefaultTimetableProject();
    controller.state.ruleReview = JSON.parse(JSON.stringify(ruleReview));
    controller.state.constraintDialog = { open: true, requirementFilter: 'review', selectedRequirementId: 'src:test' };
    controller.state.container = {
      querySelector(selector) {
        if (selector === '[data-requirement-clarify-input="src:test"]') return { value: '4' };
        return null;
      },
    };

    await controller.submitRequirementClarification('src:test');

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.answers, [{
      requirementId: 'req_test',
      sourceId: 'src:test',
      field: 'maxDaily',
      value: 4,
    }]);
    assert.equal(controller.state.ruleReview.sourceRequirements[0].sourceId, 'src:test');
    assert.equal(controller.state.ruleReview.constraintIRs[0].executionStatus, 'compiled');
    assert.equal(controller.state.ruleReview.statistics.executableMachineRuleCount, 1);
    assert.equal(controller.state.constraintDialog.selectedRequirementId, 'src:test');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('constraint dialog renders choice clarification chips and keeps review state after submit', async () => {
  const ruleReview = {
    open: true,
    mode: 'text',
    inputMode: 'text',
    draftRows: [],
    warnings: [],
    conflicts: [],
    unsupportedItems: [],
    requirementItems: [{
      id: 'req_high_load',
      object: { kind: 'derived_group', name: '高负载教师', matchedIds: ['t_math'], scope: 'derived' },
      intent: 'teacher_load_protection',
      status: 'needs_review',
      applyTo: 'optimization',
      parameters: { balancedTeacherLoad: true, maxConsecutive: 2 },
      source: { rawText: '老师别太密' },
      clarificationHistory: [{
        question: '连续超过几节算太密？',
        field: 'maxConsecutive',
        kind: 'number',
        answer: 2,
        answerLabel: '2',
      }],
      clarification: {
        id: 'clarify_req_high_load_daily_limit',
        kind: 'choice',
        field: 'dailyLimit',
        question: '还要限制每天最多几节吗？',
        options: [
          { label: '不限制每日上限', value: 'none' },
          { label: '每天最多 4 节', value: '4' },
        ],
      },
    }],
    semanticActions: [],
  };
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview,
    constraintDialog: { open: true, selectedRequirementId: 'req_high_load', requirementFilter: 'review' },
  }));

  assert.match(html, /tt-requirement-clarification-history/);
  assert.match(html, /连续超过几节算太密/);
  assert.match(html, /还要限制每天最多几节吗/);
  assert.match(html, /data-clarify-value="4"/);
  assert.match(html, /每天最多 4 节/);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          success: true,
          data: {
            draftRows: [],
            requirementItems: [{
              ...ruleReview.requirementItems[0],
              status: 'actionable',
              parameters: { balancedTeacherLoad: true, maxConsecutive: 2, dailyLimit: '4', maxDaily: 4 },
              clarification: null,
              clarificationHistory: [
                ...ruleReview.requirementItems[0].clarificationHistory,
                { question: '还要限制每天最多几节吗？', field: 'dailyLimit', kind: 'choice', answer: '4', answerLabel: '每天最多 4 节' },
              ],
            }],
            semanticActions: [{
              id: 'act_high_load',
              requirementId: 'req_high_load',
              kind: 'soft_rules_patch',
              status: 'ready',
              patch: { teacherLimits: { consecutive: 2, daily: 4 }, balancedTeacherLoad: true },
            }],
          },
        });
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.state.project = createDefaultTimetableProject();
    controller.state.ruleReview = JSON.parse(JSON.stringify(ruleReview));
    controller.state.constraintDialog = { open: true, selectedRequirementId: 'req_high_load', requirementFilter: 'review' };
    controller.state.container = { querySelector: () => null };

    await controller.submitRequirementClarification('req_high_load', '4');

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.answers, [{ requirementId: 'req_high_load', field: 'dailyLimit', value: '4' }]);
    assert.equal(controller.state.constraintDialog.requirementFilter, 'review');
    assert.equal(controller.state.constraintDialog.selectedRequirementId, 'req_high_load');
    assert.equal(controller.state.ruleReview.requirementItems[0].status, 'actionable');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('constraint dialog shows unsupported complex model support in requirement detail', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      mode: 'text',
      inputMode: 'text',
      draftRows: [],
      warnings: [],
      conflicts: [],
      unsupportedItems: [],
      requirementItems: [{
        id: 'req_campus',
        object: { kind: 'teacher', name: '张老师', matchedIds: ['t1'], scope: 'explicit' },
        intent: 'campus_commute_gap',
        status: 'needs_review',
        applyTo: 'model_extension',
        parameters: { maxConsecutiveAcrossCampus: 1 },
        source: { rawText: '张老师跨校区不要连续两节' },
        modelSupport: {
          supported: false,
          capability: 'campus_commute',
          requiredModel: 'complex_v1',
          phase: 'phase_2',
          message: '跨校区通勤需要 complex_v1 项目模型和求解器支持，当前不会自动生效。',
        },
      }],
      semanticActions: [],
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_campus' },
  }));

  assert.match(html, /模型支持/);
  assert.match(html, /complex_v1/);
  assert.match(html, /当前不会自动生效/);
});

test('constraint dialog shows supported complex model actions in requirement detail', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      mode: 'text',
      inputMode: 'text',
      draftRows: [],
      warnings: [],
      conflicts: [],
      unsupportedItems: [],
      requirementItems: [{
        id: 'req_week_pattern',
        object: { kind: 'subject', name: '语文', matchedIds: ['s1'], scope: 'explicit' },
        intent: 'preferred_periods',
        status: 'actionable',
        applyTo: 'model_extension',
        parameters: { weekPattern: 'odd', slots: ['1-1'] },
        source: { rawText: '单周语文第1节优先' },
        modelSupport: {
          supported: true,
          capability: 'weekPattern',
          requiredModel: 'complex_v1',
          phase: 'phase_2',
          message: '已启用 complex_v1，单双周需求将写入模型字段。',
        },
      }],
      semanticActions: [{
        id: 'act_week_pattern',
        requirementId: 'req_week_pattern',
        kind: 'complex_model_patch',
        status: 'ready',
        target: { subjectIds: ['s1'] },
        patch: { weekPattern: 'odd', preferredSlots: ['1-1'] },
      }],
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_week_pattern' },
  }));

  assert.match(html, /复杂模型/);
  assert.match(html, /模型支持/);
  assert.match(html, /complex_v1/);
  assert.match(html, /已支持/);
  assert.match(html, /复杂模型写入/);
  assert.match(html, /tt-constraint-info/);
});

test('constraint dialog manual entry creates an explicit requirement item', () => {
  const originalDocument = globalThis.document;
  const originalAlert = globalThis.alert;
  const originalSetTimeout = globalThis.setTimeout;
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.project = createDefaultTimetableProject({
    activeWeekdays: [1, 2, 3, 4, 5],
    activePeriods: [1, 2, 3, 4, 5, 6, 7],
    teachers: [],
    classes: [],
    subjects: [{ id: 'subject_sport', name: '体育' }],
  });
  controller.state.ruleReview = { draftRows: [], requirementItems: [], semanticActions: [] };
  controller.state.constraintDialog = { open: true, requirementFilter: 'all', selectedRequirementId: '' };
  globalThis.alert = () => {};
  globalThis.document = {
    getElementById(id) {
      return {
        'tt-manual-rule-type': { value: 'subject_preferred_periods' },
        'tt-manual-rule-target': { value: 'subject:subject_sport' },
        'tt-manual-rule-limit': { value: '' },
      }[id] || null;
    },
    querySelectorAll(selector) {
      return selector === '[data-manual-rule-slot]:checked' ? [{ value: '1-1' }] : [];
    },
  };
  globalThis.setTimeout = callback => {
    callback();
    return 0;
  };

  try {
    controller.addManualConstraint();
    assert.equal(controller.state.ruleReview.draftRows.length, 1);
    assert.equal(controller.state.ruleReview.requirementItems.length, 1);
    assert.equal(controller.state.ruleReview.sourceRequirements.length, 1);
    assert.equal(controller.state.ruleReview.manualRequirements.length, 1);
    const row = controller.state.ruleReview.draftRows[0];
    const requirement = controller.state.ruleReview.requirementItems[0];
    const sourceRequirement = controller.state.ruleReview.sourceRequirements[0];
    assert.equal(requirement.rowId, row.id);
    assert.equal(requirement.object.name, '体育');
    assert.equal(requirement.intent, 'subject_preferred_periods');
    assert.equal(requirement.source.rawText, '体育 优先安排：周一第1节');
    assert.equal(row.type, 'subject_preferred_periods');
    assert.equal(row.targetId, 'subject_sport');
    assert.deepEqual(row.slots, ['1-1']);
    assert.equal(row.priority, 'soft');
    assert.equal(row.status, 'effective');
    assert.equal(sourceRequirement.origin, 'manual');
    assert.deepEqual(sourceRequirement.parsedBy, ['manual']);
    assert.equal(sourceRequirement.sourceId, 'manual:source:' + row.id);
    assert.equal(sourceRequirement.clauses[0].clauseId, sourceRequirement.sourceId + ':clause:1');
    assert.equal(row.sourceId, sourceRequirement.sourceId);
    assert.equal(row.clauseId, sourceRequirement.clauses[0].clauseId);
    assert.equal(row.machineRuleId, sourceRequirement.sourceId + ':rule:1');
    assert.equal(requirement.sourceId, sourceRequirement.sourceId);
    assert.equal(controller.state.constraintDialog.selectedRequirementId, sourceRequirement.sourceId);
  } finally {
    globalThis.document = originalDocument;
    globalThis.alert = originalAlert;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('constraint dialog clear removes source review and legacy parse artifacts together', () => {
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.state.ruleReview = {
      sourceRequirements: [{ sourceId: 'src:1' }],
      systemSupplements: [{ supplementId: 'sys:1' }],
      manualRequirements: [{ sourceId: 'manual:1' }],
      constraintIRs: [{ constraintId: 'clause:1' }],
      warningItems: [{ sourceId: 'src:1', message: 'warning' }],
      statistics: { userInputCount: 1, clauseCount: 1 },
      draftRows: [{ id: 'row:1' }],
      requirementItems: [{ id: 'req:1' }],
      semanticActions: [{ id: 'action:1' }],
      warnings: ['warning'],
      unsupportedItems: [{ id: 'unsupported:1' }],
      excludedApplyItemKeys: ['rule:row:1'],
    };
    controller.state.constraintDialog = { open: true, requirementFilter: 'review', selectedRequirementId: 'src:1' };

    controller.clearAllConstraints();

    for (const key of [
      'sourceRequirements',
      'systemSupplements',
      'manualRequirements',
      'constraintIRs',
      'warningItems',
      'draftRows',
      'requirementItems',
      'semanticActions',
      'warnings',
      'unsupportedItems',
      'excludedApplyItemKeys',
    ]) {
      assert.deepEqual(controller.state.ruleReview[key], [], key + ' should be cleared');
    }
    assert.equal(controller.state.ruleReview.statistics, null);
    assert.equal(controller.state.constraintDialog.requirementFilter, 'all');
    assert.equal(controller.state.constraintDialog.selectedRequirementId, '');
  } finally {
    globalThis.confirm = originalConfirm;
  }
});

test('timetable constraint dialog filters semantic requirements by destination', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      draftRows: [],
      warnings: [],
      conflicts: [],
      unsupportedItems: [],
      requirementItems: [
        {
          id: 'req_rule',
          object: { kind: 'subject', name: '语文', matchedIds: ['s1'], scope: 'explicit' },
          intent: 'preferred_periods',
          status: 'actionable',
          applyTo: 'rule',
          parameters: { slots: ['1-1'] },
          source: { rawText: '语文尽量第1节' },
        },
        {
          id: 'req_block',
          object: { kind: 'subject', name: '数学', matchedIds: ['math'], scope: 'explicit' },
          intent: 'block_preference',
          status: 'actionable',
          applyTo: 'lesson_plan',
          parameters: { blockPreference: 'double' },
          source: { rawText: '数学必须连堂' },
        },
      ],
      semanticActions: [
        { id: 'act_block', requirementId: 'req_block', kind: 'lesson_plan_patch', status: 'ready' },
      ],
    },
    constraintDialog: { open: true, requirementFilter: 'lesson_plan', selectedRequirementId: 'req_block' },
  }));

  assert.match(html, /data-requirement-filter="lesson_plan"[\s\S]*aria-pressed="true"/);
  assert.match(html, /data-requirement-id="req_block"[\s\S]*is-selected/);
  assert.match(html, /<span>数学<\/span>/);
  assert.match(html, /双连堂/);
  assert.doesNotMatch(html, /<span>语文<\/span>/);
});

test('timetable constraint dialog applies only the current filtered requirements', async () => {
  const ruleReview = {
    open: true,
    step: 'review',
    mode: 'text',
    draftRows: [{
      id: 'rule-row',
      requirementId: 'req_rule',
      type: 'subject_morning',
      targetType: 'subject',
      targetName: '语文',
      status: 'effective',
      confidence: 0.94,
      warnings: [],
    }],
    warnings: [],
    conflicts: [],
    unsupportedItems: [],
    requirementItems: [
      {
        id: 'req_rule',
        object: { kind: 'subject', name: '语文', matchedIds: ['s1'], scope: 'explicit' },
        intent: 'preferred_periods',
        status: 'actionable',
        applyTo: 'rule',
        parameters: { dayPart: 'morning' },
        source: { rawText: '语文尽量上午' },
      },
      {
        id: 'req_block',
        object: { kind: 'subject', name: '数学', matchedIds: ['math'], scope: 'explicit' },
        intent: 'block_preference',
        status: 'actionable',
        applyTo: 'lesson_plan',
        parameters: { blockPreference: 'double' },
        source: { rawText: '数学必须连堂' },
      },
    ],
    semanticActions: [
      { id: 'act_block', requirementId: 'req_block', kind: 'lesson_plan_patch', status: 'ready', payload: { blockPreference: 'double' } },
    ],
  };
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview,
    constraintDialog: { open: true, requirementFilter: 'lesson_plan', selectedRequirementId: 'req_block' },
  }));
  assert.match(html, /data-requirement-filter="lesson_plan"[\s\S]*aria-pressed="true"/);
  assert.match(html, /data-action="toggle-constraint-apply-item"/);
  assert.match(html, /data-apply-item-key="action:act_block"/);
  assert.match(html, /暂停应用/);
  assert.match(html, /应用当前分类 \(1\)/);
  assert.doesNotMatch(html, /应用需求 \(2\)/);

  const calls = [];
  const alerts = [];
  const confirmations = [];
  const originalFetch = globalThis.fetch;
  const originalConfirm = globalThis.confirm;
  const originalAlert = globalThis.alert;
  globalThis.confirm = message => {
    confirmations.push(message);
    return true;
  };
  globalThis.alert = message => alerts.push(message);
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/rules/normalize')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              draftRows: [{ id: 'rule-row', status: 'effective' }],
              draftRules: { hardRules: {}, softRules: { subjectMorning: ['s1'] } },
            },
          });
        },
      };
    }
    if (String(url).endsWith('/rules')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            success: true,
            data: { project: createDefaultTimetableProject() },
          });
        },
      };
    }
    if (String(url).endsWith('/requirements/apply')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              project: createDefaultTimetableProject(),
              applied: [{ id: 'act_block' }],
              skipped: [],
              needsReview: [],
            },
          });
        },
      };
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.state.project = createDefaultTimetableProject();
    controller.state.ruleReview = JSON.parse(JSON.stringify(ruleReview));
    controller.state.constraintDialog = { open: true, requirementFilter: 'lesson_plan', selectedRequirementId: 'req_block' };

    await controller.applyConstraintsFromDialog();

    assert.deepEqual(calls.filter(call => call.url.endsWith('/rules/normalize')), []);
    assert.deepEqual(calls.filter(call => call.url.endsWith('/rules')), []);
    assert.deepEqual(
      calls.find(call => call.url.endsWith('/requirements/apply'))?.body.actions.map(action => action.id),
      ['act_block']
    );
    assert.deepEqual(controller.state.ruleReview.draftRows.map(row => row.id), ['rule-row']);
    assert.deepEqual(controller.state.ruleReview.semanticActions.map(action => action.id), []);
    assert.ok(confirmations.some(message => /当前分类的 1 条需求/.test(message)));
    assert.ok(alerts.some(message => /已写入 0 条硬规则、0 条软规则，更新 1 个任课计划。共 1 条已生效。/.test(message)));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.confirm = originalConfirm;
    globalThis.alert = originalAlert;
  }
});

test('constraint dialog marks fully applied source handled but keeps partially unsupported source for review', async () => {
  const pureClause = {
    id: 'req_pure',
    requirementId: 'req_pure',
    sourceId: 'src:pure',
    clauseId: 'src:pure:clause:1',
    machineRuleIds: ['src:pure:rule:1'],
    intent: 'subject_morning',
    status: 'actionable',
    reviewStatus: 'actionable',
    executionStatus: 'executable',
    applyTo: 'rule',
    object: { kind: 'subject', name: '语文' },
  };
  const mixedExecutableClause = {
    id: 'req_mixed_exec',
    requirementId: 'req_mixed_exec',
    sourceId: 'src:mixed',
    clauseId: 'src:mixed:clause:1',
    machineRuleIds: ['src:mixed:rule:1'],
    intent: 'course_interval',
    status: 'actionable',
    reviewStatus: 'actionable',
    executionStatus: 'executable',
    applyTo: 'rule',
    object: { kind: 'subject', name: '地理、生物' },
  };
  const mixedUnsupportedClause = {
    id: 'req_mixed_review',
    requirementId: 'req_mixed_review',
    sourceId: 'src:mixed',
    clauseId: 'src:mixed:clause:2',
    intent: 'weekday_concentration',
    status: 'unsupported',
    reviewStatus: 'unsupported',
    executionStatus: 'unsupported_by_solver',
    applyTo: 'review',
    object: { kind: 'subject', name: '地理、生物' },
  };
  const ruleReview = {
    sourceRequirements: [
      {
        sourceId: 'src:pure',
        origin: 'user_input',
        rawText: '语文尽量上午。',
        status: 'actionable',
        reviewStatus: 'actionable',
        executionStatus: 'executable',
        clauses: [pureClause],
        machineRuleIds: ['src:pure:rule:1'],
      },
      {
        sourceId: 'src:mixed',
        origin: 'user_input',
        rawText: '地理和生物尽量隔天分布，不要都挤在周四周五。',
        status: 'partially_supported',
        reviewStatus: 'partially_supported',
        executionStatus: 'partially_executable',
        clauses: [mixedExecutableClause, mixedUnsupportedClause],
        machineRuleIds: ['src:mixed:rule:1'],
      },
    ],
    constraintIRs: [pureClause, mixedExecutableClause, mixedUnsupportedClause],
    draftRows: [
      {
        id: 'row:pure',
        sourceId: 'src:pure',
        clauseId: pureClause.clauseId,
        machineRuleId: 'src:pure:rule:1',
        requirementId: pureClause.requirementId,
        type: 'subject_morning',
        targetType: 'subject',
        targetName: '语文',
        status: 'effective',
      },
      {
        id: 'row:mixed',
        sourceId: 'src:mixed',
        clauseId: mixedExecutableClause.clauseId,
        machineRuleId: 'src:mixed:rule:1',
        requirementId: mixedExecutableClause.requirementId,
        type: 'course_interval',
        targetType: 'subject',
        targetName: '地理、生物',
        status: 'effective',
      },
    ],
    requirementItems: [pureClause, mixedExecutableClause, mixedUnsupportedClause],
    semanticActions: [],
    conflicts: [],
    warnings: [],
  };
  const originalFetch = globalThis.fetch;
  const originalConfirm = globalThis.confirm;
  const originalAlert = globalThis.alert;
  globalThis.confirm = () => true;
  globalThis.alert = () => {};
  globalThis.fetch = async url => {
    if (String(url).endsWith('/rules/normalize')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              draftRows: [{ id: 'row:pure', status: 'effective' }, { id: 'row:mixed', status: 'effective' }],
              draftRules: { hardRules: {}, softRules: {} },
            },
          });
        },
      };
    }
    if (String(url).endsWith('/rules')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ success: true, data: { project: createDefaultTimetableProject() } });
        },
      };
    }
    if (String(url).endsWith('/rules/diagnose')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ success: true, data: { diagnosis: { blockingRules: [], conflicts: [] } } });
        },
      };
    }
    throw new Error('Unexpected fetch ' + url);
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.state.project = createDefaultTimetableProject();
    controller.state.ruleReview = JSON.parse(JSON.stringify(ruleReview));
    controller.state.constraintDialog = { open: true, requirementFilter: 'all', selectedRequirementId: 'src:pure' };

    await controller.applyConstraintsFromDialog();

    assert.deepEqual(controller.state.ruleReview.draftRows, []);
    const pureSource = controller.state.ruleReview.sourceRequirements.find(item => item.sourceId === 'src:pure');
    const mixedSource = controller.state.ruleReview.sourceRequirements.find(item => item.sourceId === 'src:mixed');
    assert.equal(pureSource.status, 'handled');
    assert.equal(pureSource.reviewStatus, 'handled');
    assert.equal(pureSource.executionStatus, 'applied');
    assert.equal(mixedSource.status, 'partially_supported');
    assert.equal(mixedSource.reviewStatus, 'partially_supported');
    assert.equal(controller.state.constraintDialog.open, true);
    assert.equal(controller.state.constraintDialog.selectedRequirementId, 'src:mixed');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.confirm = originalConfirm;
    globalThis.alert = originalAlert;
  }
});

test('timetable constraint dialog treats missing origin as unknown and excludes it from user input statistics', () => {
  const review = {
    sourceRequirements: [{
      sourceId: 'src:missing-origin',
      textHash: 'hash-missing-origin',
      rawText: '来源字段缺失时不能冒充用户输入。',
      status: 'needs_review',
      reviewStatus: 'needs_review',
      understandingStatus: 'unrecognized',
      executionStatus: 'needs_review',
      clauses: [],
      machineRuleIds: [],
      source: { rawText: '来源字段缺失时不能冒充用户输入。' },
    }, {
      sourceId: 'src:real-user',
      textHash: 'hash-real-user',
      rawText: '这条才是明确的用户输入。',
      origin: 'user_input',
      status: 'needs_review',
      reviewStatus: 'needs_review',
      clauses: [],
      machineRuleIds: [],
    }],
    systemSupplements: [],
    requirementItems: [],
    constraintIRs: [],
    draftRows: [],
    semanticActions: [],
    warnings: [],
    conflicts: [],
    unsupportedItems: [],
  };

  refreshReviewStatistics(review);
  assert.equal(review.statistics.sourceRequirementCount, 2);
  assert.equal(review.statistics.userInputCount, 1);

  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: { ...review, open: true, step: 'review', mode: 'text' },
    constraintDialog: {
      open: true,
      requirementFilter: 'all',
      selectedRequirementId: 'src:missing-origin',
    },
  }));

  assert.match(html, /用户输入 1 条/);
  assert.match(html, /data-requirement-id="src:missing-origin"[\s\S]*?<small>来源未知<\/small>/);
  assert.doesNotMatch(
    html.match(/data-requirement-id="src:missing-origin"[\s\S]*?<\/button>/)?.[0] || '',
    /我的输入/
  );
});

test('review statistics preserve singleton parse result collections', () => {
  const review = {
    sourceRequirements: {
      sourceId: 'src:singleton',
      origin: 'user_input',
      status: 'understood',
      understandingStatus: 'parsed',
      executionStatus: 'executable',
      clauses: { clauseId: 'clause:singleton' },
    },
    systemSupplements: { supplementId: 'supplement:singleton' },
    draftRows: [
      { id: 'row:singleton', machineRuleId: 'machine:singleton', status: 'effective' },
      { id: 'row:review', status: 'needs_review', executionStatus: 'unsupported_by_solver' },
    ],
    semanticActions: { id: 'action:singleton' },
  };

  refreshReviewStatistics(review);

  assert.equal(review.statistics.sourceRequirementCount, 1);
  assert.equal(review.statistics.userInputCount, 1);
  assert.equal(review.statistics.systemSupplementCount, 1);
  assert.equal(review.statistics.clauseCount, 1);
  assert.equal(review.statistics.machineRuleCount, 1);
  assert.equal(review.statistics.executableMachineRuleCount, 1);
  assert.equal(review.statistics.draftRowCount, 2);
  assert.equal(review.statistics.semanticActionCount, 1);
});

test('review statistics use canonical source state and ignore advisory AI flags', () => {
  const review = {
    sourceRequirements: [{
      sourceId: 'src:advisory',
      origin: 'user_input',
      status: 'needs_review',
      reviewStatus: 'needs_review',
      understandingStatus: 'parsed',
      executionStatus: 'executable',
      applicationTarget: 'rule',
      requiresHumanReview: false,
      clauses: [{
        clauseId: 'clause:advisory',
        executionStatus: 'executable',
        aiReviewStatus: 'flagged',
        aiReviewValidationStatus: 'advisory',
        aiReviewBlocking: false,
      }],
      machineRuleIds: ['machine:advisory'],
    }],
    systemSupplements: [],
    draftRows: [{ id: 'row:advisory', machineRuleId: 'machine:advisory', status: 'effective' }],
    semanticActions: [],
  };

  refreshReviewStatistics(review);
  assert.equal(review.statistics.sourceRequirementCount, 1);
  assert.equal(review.statistics.needsReviewCount, 0);
  assert.equal(review.statistics.executableMachineRuleCount, 1);
});

test('timetable constraint dialog uses source statistics and renders clauses without inflating top-level cards', () => {
  const executableClause = {
    id: 'req_market_exec',
    requirementId: 'req_market_exec',
    sourceId: 'src:market-language',
    clauseId: 'src:market-language:clause:1',
    machineRuleIds: ['src:market-language:rule:1'],
    intent: 'course_interval',
    status: 'actionable',
    reviewStatus: 'actionable',
    understandingStatus: 'parsed',
    executionStatus: 'executable',
    applyTo: 'rule',
    object: { kind: 'subject', name: '地理、生物' },
  };
  const unsupportedClause = {
    id: 'req_market_unsupported',
    requirementId: 'req_market_unsupported',
    sourceId: 'src:market-language',
    clauseId: 'src:market-language:clause:2',
    machineRuleIds: [],
    intent: 'weekday_concentration',
    status: 'unsupported',
    reviewStatus: 'unsupported',
    understandingStatus: 'parsed',
    executionStatus: 'unsupported_by_solver',
    applyTo: 'review',
    object: { kind: 'subject', name: '地理、生物' },
    warnings: ['当前求解器还不能表达“不要都挤在周四周五”。'],
  };
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      statistics: {
        userInputCount: 137,
        systemSupplementCount: 1,
        clauseCount: 150,
        executableMachineRuleCount: 128,
        needsReviewCount: 3,
        blockedReferenceSourceCount: 1,
        blockedClarificationSourceCount: 1,
        unsupportedSolverSourceCount: 1,
      },
      sourceRequirements: [{
        sourceId: 'src:market-language',
        textHash: 'hash-market-language',
        rawText: '地理和生物尽量隔天分布，不要都挤在周四周五。',
        origin: 'user_input',
        parsedBy: ['local', 'ai'],
        status: 'partially_supported',
        reviewStatus: 'partially_supported',
        executionStatus: 'partially_executable',
        clauses: [executableClause, unsupportedClause],
        machineRuleIds: ['src:market-language:rule:1'],
      }],
      constraintIRs: [executableClause, unsupportedClause],
      draftRows: [{
        id: 'row:market-language',
        sourceId: 'src:market-language',
        clauseId: executableClause.clauseId,
        requirementId: executableClause.requirementId,
        machineRuleId: 'src:market-language:rule:1',
        type: 'course_interval',
        targetType: 'subject',
        targetName: '地理、生物',
        status: 'effective',
      }],
      requirementItems: [executableClause, unsupportedClause],
      semanticActions: [],
      systemSupplements: [{
        supplementId: 'supplement:teacher-conflict',
        reason: '同一位教师同一时间只能上一节课。',
        requirement: {
          id: 'req_system_teacher_conflict',
          requirementId: 'req_system_teacher_conflict',
          intent: 'teacher_conflict',
          status: 'handled',
          applyTo: 'handled',
          object: { kind: 'global', name: '全校教师' },
          source: { rawText: '同一位教师同一时间只能上一节课。' },
        },
      }],
      warnings: [],
      conflicts: [],
      unsupportedItems: [],
    },
    constraintDialog: {
      open: true,
      requirementFilter: 'all',
      selectedRequirementId: 'src:market-language',
      systemGroupCollapsed: false,
    },
  }));

  assert.match(html, /用户输入 137 条/);
  assert.match(html, /系统补充 1 条/);
  assert.match(html, /子约束 150 条/);
  assert.match(html, /可执行规则 128 条/);
  assert.match(html, /待绑定 1 条/);
  assert.match(html, /待补充 1 条/);
  assert.match(html, /真正不支持 1 条/);
  assert.equal((html.match(/data-requirement-id="src:market-language"/g) || []).length, 1);
  assert.match(html, /data-requirement-id="src:market-language"[^>]*title="地理和生物尽量隔天分布，不要都挤在周四周五。"/);
  assert.match(html, /data-requirement-id="src:market-language"[\s\S]*?<small>我的输入<\/small>/);
  assert.match(html, /本地 \+ AI 解析/);
  assert.match(html, /理解为 2 个子约束/);
  assert.match(html, /已理解，但当前求解器暂不支持/);
  assert.match(html, /系统补充的默认规则/);
});
test('timetable smart helper summary counts source requirements instead of expanded machine rows', () => {
  const sourceRequirements = Array.from({ length: 137 }, (_, index) => ({
    sourceId: `src:sidebar:${index + 1}`,
    rawText: `第 ${index + 1} 条自然语言约束`,
    origin: 'user_input',
    status: 'actionable',
    clauses: [],
    machineRuleIds: [],
  }));
  const draftRows = Array.from({ length: 128 }, (_, index) => ({
    id: `row:sidebar:${index + 1}`,
    machineRuleId: `rule:sidebar:${index + 1}`,
    type: 'teacher_unavailable',
    status: 'effective',
  }));
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      sourceRequirements,
      draftRows,
      requirementItems: [],
      semanticActions: [],
      statistics: {
        userInputCount: 137,
        clauseCount: 150,
        executableMachineRuleCount: 128,
      },
    },
  }));
  const sidebar = html.match(/<aside class="tt-sidebar">([\s\S]*?)<\/aside>\s*<section class="tt-schedule-panel">/)?.[1] || '';

  assert.match(sidebar, /<span class="tt-chip">137 条<\/span>/);
  assert.match(sidebar, /137 条要求待处理/);
  assert.doesNotMatch(sidebar, /128 条要求待处理/);

  const explicitEmptyHtml = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      sourceRequirements: [],
      draftRows,
      requirementItems: [],
      semanticActions: [],
    },
  }));
  const explicitEmptySidebar = explicitEmptyHtml.match(/<aside class="tt-sidebar">([\s\S]*?)<\/aside>\s*<section class="tt-schedule-panel">/)?.[1] || '';
  assert.doesNotMatch(explicitEmptySidebar, /128 条要求待处理/);

  const legacyHtml = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      draftRows: draftRows.slice(0, 3),
      requirementItems: [],
      semanticActions: [],
    },
  }));
  const legacySidebar = legacyHtml.match(/<aside class="tt-sidebar">([\s\S]*?)<\/aside>\s*<section class="tt-schedule-panel">/)?.[1] || '';
  assert.match(legacySidebar, /<span class="tt-chip">3 条<\/span>/);
  assert.match(legacySidebar, /3 条要求待处理/);
});
test('timetable constraint dialog can remove and restore one apply item without deleting it', () => {
  const ruleReview = {
    open: true,
    step: 'review',
    mode: 'text',
    draftRows: [{
      id: 'rule-row',
      requirementId: 'req_rule',
      type: 'subject_morning',
      targetType: 'subject',
      targetName: '语文',
      status: 'effective',
      confidence: 0.94,
      warnings: [],
    }],
    warnings: [],
    conflicts: [],
    unsupportedItems: [],
    requirementItems: [{
      id: 'req_rule',
      object: { kind: 'subject', name: '语文', matchedIds: ['s1'], scope: 'explicit' },
      intent: 'preferred_periods',
      status: 'actionable',
      applyTo: 'rule',
      parameters: { dayPart: 'morning' },
      source: { rawText: '语文尽量上午' },
    }],
    semanticActions: [],
  };
  const initialHtml = renderWorkbench(sampleWorkbenchState({
    ruleReview,
    constraintDialog: { open: true, requirementFilter: 'rule', selectedRequirementId: 'req_rule' },
  }));
  assert.match(initialHtml, /data-apply-item-key="rule:rule-row"/);
  assert.match(initialHtml, /暂停应用/);
  assert.match(initialHtml, /应用当前分类 \(1\)/);

  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.ruleReview = JSON.parse(JSON.stringify(ruleReview));
  controller.state.constraintDialog = { open: true, requirementFilter: 'rule', selectedRequirementId: 'req_rule' };

  controller.toggleConstraintApplyItem('rule:rule-row');

  assert.deepEqual(controller.state.ruleReview.excludedApplyItemKeys, ['rule:rule-row']);
  assert.deepEqual(controller.state.ruleReview.draftRows.map(row => row.id), ['rule-row']);
  const removedHtml = renderWorkbench(sampleWorkbenchState({
    ruleReview: controller.state.ruleReview,
    constraintDialog: controller.state.constraintDialog,
  }));
  assert.match(removedHtml, /tt-constraint-card--excluded/);
  assert.match(removedHtml, /恢复应用/);
  assert.doesNotMatch(removedHtml, /应用当前分类 \(1\)/);

  controller.toggleConstraintApplyItem('rule:rule-row');

  assert.deepEqual(controller.state.ruleReview.excludedApplyItemKeys, []);
  const restoredHtml = renderWorkbench(sampleWorkbenchState({
    ruleReview: controller.state.ruleReview,
    constraintDialog: controller.state.constraintDialog,
  }));
  assert.match(restoredHtml, /暂停应用/);
  assert.match(restoredHtml, /应用当前分类 \(1\)/);
});

test('timetable renders constraint intake agent as an embedded rules workflow panel', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: false,
      step: 'review',
      mode: 'text',
      draftRows: [{
        id: 'rule-row',
        requirementId: 'req_rule',
        type: 'subject_preferred_periods',
        targetName: '语文',
        priority: 'soft',
        status: 'effective',
        rawText: '语文尽量上午',
      }],
      requirementItems: [{
        id: 'req_rule',
        object: { kind: 'subject', name: '语文', matchedIds: ['s1'], scope: 'explicit' },
        intent: 'preferred_periods',
        status: 'actionable',
        applyTo: 'rule',
        source: { rawText: '语文尽量上午' },
      }],
      semanticActions: [],
      excludedApplyItemKeys: [],
    },
    constraintAgent: {
      sessionId: 'agent-session',
      stage: 'CONFIRM',
      messages: [{ role: 'assistant', content: '我已生成可复核的需求卡。' }],
      statusLine: '[已理解 1 · 待澄清 0 · 待确认 1]',
      confirmationToken: 'confirm_apply_1',
      loading: false,
      error: '',
      input: '',
    },
  }));

  assert.match(html, /tt-constraint-agent-panel/);
  assert.match(html, /data-constraint-agent-stage="CONFIRM"/);
  assert.match(html, /对话排课/);
  assert.match(html, /\[已理解 1 · 待澄清 0 · 待确认 1\]/);
  assert.match(html, /data-action="constraint-agent-start"/);
  assert.match(html, /data-action="constraint-agent-send"/);
  assert.match(html, /data-action="constraint-agent-confirm"/);
  assert.match(html, /data-action="constraint-agent-apply"/);
  assert.match(html, /data-action="constraint-agent-solve"/);
  assert.match(html, /data-apply-item-key="rule:rule-row"/);
  assert.doesNotMatch(html, /id="tt-agent-floating"/);
  assert.doesNotMatch(html, /class="tt-agent-toggle"/);
  assert.doesNotMatch(html, /class="tt-agent-floating-panel"/);
  assert.doesNotMatch(html, /id="tt-timetable-agent-panel"/);
});

test('constraint intake mini cards share excluded apply state with rule review table', () => {
  const ruleReview = {
    open: true,
    step: 'review',
    mode: 'text',
    draftRows: [{
      id: 'rule-row',
      requirementId: 'req_rule',
      type: 'subject_preferred_periods',
      targetName: '语文',
      priority: 'soft',
      status: 'effective',
      rawText: '语文尽量上午',
    }],
    requirementItems: [{
      id: 'req_rule',
      object: { kind: 'subject', name: '语文', matchedIds: ['s1'], scope: 'explicit' },
      intent: 'preferred_periods',
      status: 'actionable',
      applyTo: 'rule',
      source: { rawText: '语文尽量上午' },
    }],
    semanticActions: [],
    excludedApplyItemKeys: [],
  };

  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.ruleReview = JSON.parse(JSON.stringify(ruleReview));
  controller.toggleConstraintApplyItem('rule:rule-row');

  assert.deepEqual(controller.state.ruleReview.excludedApplyItemKeys, ['rule:rule-row']);

  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: controller.state.ruleReview,
    constraintDialog: { open: true, requirementFilter: 'rule', selectedRequirementId: 'req_rule' },
    constraintAgent: {
      sessionId: 'agent-session',
      stage: 'CONFIRM',
      messages: [],
      statusLine: '[已理解 1 · 待澄清 0 · 待确认 1]',
      confirmationToken: 'confirm_apply_1',
      loading: false,
      error: '',
    },
  }));

  assert.match(html, /tt-constraint-agent-mini-card is-excluded/);
  assert.match(html, /恢复/);
  assert.match(html, /tt-constraint-card--excluded/);
});

test('constraint intake agent normalizes singleton source-first review fields without legacy rows', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.ruleReview = {
    ...(controller.state.ruleReview || {}),
    open: true,
    uiStep: 'input',
  };
  const sourceRequirement = {
    sourceId: 'src:agent:math-morning',
    rawText: 'Math 尽量上午',
    origin: 'user_input',
    parsedBy: ['local', 'ai'],
    clauses: [{
      clauseId: 'src:agent:math-morning:clause:1',
      intent: 'subject.preferred_periods',
      understandingStatus: 'parsed',
      executionStatus: 'unsupported_by_solver',
    }],
  };
  const review = {
    schemaVersion: 2,
    sourceRequirements: sourceRequirement,
    systemSupplements: { sourceId: 'sys:agent:1', origin: 'system_supplement', rawText: '系统补充' },
    manualRequirements: { sourceId: 'manual:agent:1', origin: 'manual', rawText: '手动补充' },
    constraintIRs: {
      sourceId: sourceRequirement.sourceId,
      clauseId: sourceRequirement.clauses[0].clauseId,
      intent: 'subject.preferred_periods',
    },
    warningItems: {
      sourceId: sourceRequirement.sourceId,
      code: 'solver_unsupported',
      message: '已理解，但当前求解器暂不支持。',
    },
    statistics: {
      userInputCount: 1,
      systemSupplementCount: 1,
      clauseCount: 1,
      executableMachineRuleCount: 0,
      needsReviewCount: 1,
    },
    draftRows: { id: 'row:agent:1', sourceId: sourceRequirement.sourceId, status: 'effective' },
    requirementItems: { id: 'req:agent:1', sourceId: sourceRequirement.sourceId },
    semanticActions: { id: 'action:agent:1', sourceId: sourceRequirement.sourceId },
    warnings: 'singleton warning',
    excludedApplyItemKeys: 'rule:row:agent:1',
  };

  controller.syncConstraintAgentReview({ review, excludedApplyItemKeys: review.excludedApplyItemKeys });

  assert.equal(controller.state.ruleReview.uiStep, 'issues');
  assert.equal(controller.state.ruleReview.schemaVersion, 2);
  assert.deepEqual(controller.state.ruleReview.sourceRequirements, [sourceRequirement]);
  assert.deepEqual(controller.state.ruleReview.systemSupplements, [review.systemSupplements]);
  assert.deepEqual(controller.state.ruleReview.manualRequirements, [review.manualRequirements]);
  assert.deepEqual(controller.state.ruleReview.constraintIRs, [review.constraintIRs]);
  assert.deepEqual(controller.state.ruleReview.warningItems, [review.warningItems]);
  assert.deepEqual(controller.state.ruleReview.draftRows, [review.draftRows]);
  assert.deepEqual(controller.state.ruleReview.requirementItems, [review.requirementItems]);
  assert.deepEqual(controller.state.ruleReview.semanticActions, [review.semanticActions]);
  assert.deepEqual(controller.state.ruleReview.warnings, [review.warnings]);
  assert.deepEqual(controller.state.ruleReview.excludedApplyItemKeys, [review.excludedApplyItemKeys]);
  assert.deepEqual(controller.state.ruleReview.statistics, review.statistics);
});

test('constraint intake agent preserves legacy fallback when review omits sourceRequirements', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.ruleReview = {
    ...(controller.state.ruleReview || {}),
    open: true,
    sourceRequirements: [{ sourceId: 'src:stale', rawText: 'stale source' }],
  };
  const legacyRequirement = {
    id: 'legacy-agent-req',
    origin: 'user_input',
    object: { kind: 'subject', name: '数学' },
    intent: 'preferred_periods',
    status: 'actionable',
    applyTo: 'rule',
    source: { rawText: '数学尽量上午', origin: 'user_input' },
  };

  controller.syncConstraintAgentReview({
    review: {
      draftRows: [],
      requirementItems: [legacyRequirement],
      semanticActions: [],
    },
  });

  assert.equal(controller.state.ruleReview.sourceRequirements, undefined);
  assert.deepEqual(controller.state.ruleReview.requirementItems, [legacyRequirement]);
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: controller.state.ruleReview,
    constraintDialog: {
      open: true,
      requirementFilter: 'all',
      selectedRequirementId: 'legacy-agent-req',
    },
  }));
  assert.match(html, /data-requirement-id="legacy-agent-req"/);
  assert.doesNotMatch(html, /stale source/);
});

test('constraint dialog opening preserves legacy fallback when sourceRequirements is absent', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  const legacyRequirement = {
    id: 'legacy-open-req',
    origin: 'user_input',
    object: { kind: 'subject', name: '数学' },
    intent: 'preferred_periods',
    status: 'actionable',
    applyTo: 'rule',
    source: { rawText: '数学尽量上午', origin: 'user_input' },
  };
  controller.state.ruleReview = {
    open: false,
    inputMode: 'text',
    draftRows: [],
    requirementItems: [legacyRequirement],
    semanticActions: [],
  };
  controller.state.constraintDialog = { open: false };

  controller.openConstraintDialog('text');

  assert.equal(controller.state.ruleReview.sourceRequirements, undefined);
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: controller.state.ruleReview,
    constraintDialog: {
      ...controller.state.constraintDialog,
      open: true,
      requirementFilter: 'all',
      selectedRequirementId: 'legacy-open-req',
    },
  }));
  assert.match(html, /data-requirement-id="legacy-open-req"/);
});

test('constraint intake controller calls dedicated agent API endpoints', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 4,
    activeWeekdays: [1, 2, 3, 4, 5],
    activePeriods: [1, 2, 3, 4],
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
    rules: { hardRules: {}, softRules: {} },
  });
  const review = {
    draftRows: [{
      id: 'rule-row',
      requirementId: 'req_rule',
      type: 'subject_preferred_periods',
      targetName: 'Math',
      priority: 'soft',
      status: 'effective',
      rawText: 'Math 尽量上午',
    }],
    requirementItems: [{
      id: 'req_rule',
      object: { kind: 'subject', name: 'Math', matchedIds: ['math'], scope: 'explicit' },
      intent: 'preferred_periods',
      status: 'actionable',
      applyTo: 'rule',
      source: { rawText: 'Math 尽量上午' },
    }],
    semanticActions: [],
    warnings: [],
    conflicts: [],
  };

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ url: String(url), body });
    const path = String(url);
    let data = {};
    if (path.endsWith('/constraint-intake/session')) {
      data = {
        sessionId: 'agent-session',
        state: {
          sessionId: 'agent-session',
          stage: 'INTAKE',
          statusLine: '[已理解 0 · 待澄清 0 · 待确认 0]',
          messages: [],
        },
      };
    } else if (path.endsWith('/constraint-intake/message')) {
      data = {
        sessionId: 'agent-session',
        stage: 'CONFIRM',
        reply: '已生成需求卡。',
        statusLine: '[已理解 1 · 待澄清 0 · 待确认 1]',
        review,
        confirmationToken: 'confirm_apply_1',
        confirmed: false,
      };
    } else if (path.endsWith('/constraint-intake/confirm')) {
      data = {
        sessionId: 'agent-session',
        stage: 'CONFIRM',
        reply: '已确认。',
        statusLine: '[已理解 1 · 待澄清 0 · 待确认 0]',
        review,
        confirmationToken: 'confirm_apply_1',
        confirmed: true,
        excludedApplyItemKeys: body.excludedApplyItemKeys || [],
      };
    } else if (path.endsWith('/constraint-intake/apply')) {
      data = {
        sessionId: 'agent-session',
        stage: 'APPLY',
        reply: '已应用。',
        statusLine: '[已理解 1 · 待澄清 0 · 待确认 0]',
        review,
        confirmationToken: 'confirm_apply_1',
        confirmed: false,
        project,
        appliedSummary: { appliedRuleCount: 1, appliedSemanticActionCount: 0, skippedCount: body.excludedApplyItemKeys?.length || 0 },
      };
    } else if (path.endsWith('/constraint-intake/solve')) {
      data = {
        sessionId: 'agent-session',
        stage: 'REPORT',
        reply: '已完成求解并生成约束满足度报告。',
        statusLine: '[已理解 1 · 待澄清 0 · 待确认 0]',
        review,
        project,
        solveResult: { success: true, schedule: { slots: [] } },
        fulfillment: { summary: { total: 1, violated: 0 }, items: [] },
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ success: true, data });
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.applyProject(project);

    await controller.sendConstraintIntakeAgentMessage('Math 尽量上午');
    controller.state.ruleReview.excludedApplyItemKeys = ['rule:rule-row'];
    await controller.confirmConstraintIntakeAgent();
    await controller.applyConstraintIntakeAgent();
    await controller.solveConstraintIntakeAgent();

    assert.deepEqual(
      calls.map(call => call.url.replace('/api/tools/timetable/agent', '')),
      [
        '/constraint-intake/session',
        '/constraint-intake/message',
        '/constraint-intake/confirm',
        '/constraint-intake/apply',
        '/constraint-intake/solve',
      ],
    );
    assert.equal(calls[1].body.message, 'Math 尽量上午');
    assert.deepEqual(calls[2].body.excludedApplyItemKeys, ['rule:rule-row']);
    assert.deepEqual(calls[3].body.excludedApplyItemKeys, ['rule:rule-row']);
    assert.equal(controller.state.constraintAgent.stage, 'REPORT');
    assert.equal(controller.state.constraintFulfillment.summary.total, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable solve UI shows large-project estimate and current timeout', () => {
  const largeProject = createDefaultTimetableProject({
    schoolName: 'Large UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 6,
    activeWeekdays: [1, 2, 3, 4, 5],
    activePeriods: [1, 2, 3, 4, 5, 6],
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: Array.from({ length: 30 }, (_, index) => ({ id: `c${index + 1}`, grade: 'G7', name: `${index + 1}` })),
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: Array.from({ length: 30 }, (_, index) => ({
      id: `lp_math_${index + 1}`,
      classId: `c${index + 1}`,
      subjectId: 'math',
      teacherId: 't_math',
      weeklyHours: 3,
    })),
    rules: { hardRules: {}, softRules: {} },
  });

  const html = renderWorkbench(sampleWorkbenchState({
    project: largeProject,
    loading: true,
    solvePhaseText: '局部优化中 · 30 个班，预计需要数分钟；当前 Timefold 超时上限 420 秒。',
    solveScaleHint: {
      largeProject: true,
      classCount: 30,
      lessonCount: 90,
      timeoutSeconds: 420,
      message: '30 个班，预计需要数分钟；当前 Timefold 超时上限 420 秒。',
    },
  }));

  assert.match(html, /30 个班，预计需要数分钟/);
  assert.match(html, /当前 Timefold 超时上限 420 秒/);
  assert.match(html, /局部优化中/);
});

test('timetable constraint edit opens a compact machine-rule modal', () => {
  const editingConstraint = {
    id: 'rule-row',
    originalId: 'rule-row',
    requirementId: 'req_rule',
    type: 'subject_preferred_periods',
    targetType: 'subject',
    targetId: 'math',
    targetName: 'Math',
    slots: ['1-1', '1-2'],
    priority: 'soft',
    status: 'effective',
    rawText: 'Math should prefer Monday periods 1-2',
    sourceSheet: 'AI约束建议',
    sourceRow: 2,
    parseSource: 'local_xlsx',
  };
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      draftRows: [editingConstraint],
      requirementItems: [{
        id: 'req_rule',
        object: { kind: 'subject', name: 'Math', matchedIds: ['math'], scope: 'explicit' },
        intent: 'preferred_periods',
        status: 'actionable',
        applyTo: 'rule',
        parameters: { slots: ['1-1', '1-2'] },
        source: { rawText: 'Math should prefer Monday periods 1-2', sourceRow: 2 },
      }],
      semanticActions: [],
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_rule', editingConstraint },
  }));

  assert.match(html, /tt-constraint-edit-backdrop/);
  assert.match(html, /tt-constraint-edit-modal/);
  assert.match(html, /编辑将应用规则/);
  assert.match(html, /data-action="save-edit-constraint"/);
  assert.match(html, /data-action="cancel-edit-constraint"/);
  assert.match(html, /value="subject_preferred_periods" selected/);
  assert.match(html, /value="subject:math" selected/);
  assert.match(html, /value="1-1" checked/);
  assert.match(html, /value="1-2" checked/);
  assert.match(html, /AI约束建议 第 2 行 · 本地识别/);
  assert.doesNotMatch(html, /id="tt-edit-constraint-priority"/);
  assert.doesNotMatch(html, /id="tt-edit-constraint-status"/);
  assert.doesNotMatch(html, /<div class="tt-constraint-edit-form">/);
});

test('timetable constraint edit requires explicit conversion for legacy manual placeholder types', () => {
  const legacy = {
    id: 'manual-legacy',
    originalId: 'manual-legacy',
    type: 'prefer',
    targetName: '数学',
    timeLabel: '周一上午',
    status: 'ready',
    origin: 'manual',
  };
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: { open: true, mode: 'manual', draftRows: [legacy] },
    constraintDialog: { open: true, editingConstraint: legacy },
  }));

  assert.match(html, /value="" selected[^>]*>请选择具体规则类型/);
  assert.match(html, /旧手动内容需要先选择具体规则类型和项目对象/);
  assert.doesNotMatch(html, /value="subject_preferred_periods" selected/);
});

test('timetable constraint edit saves business fields back to the draft rule', () => {
  const originalDocument = globalThis.document;
  const originalAlert = globalThis.alert;
  const alerts = [];
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.detectConstraintConflicts = () => {};
  controller.state.project = createDefaultTimetableProject({
    activeWeekdays: [1, 2],
    activePeriods: [1, 2, 3],
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [
      { id: 'math', name: 'Math', priority: 90, color: '#2563eb' },
      { id: 'english', name: 'English', priority: 90, color: '#0891b2' },
    ],
    lessonPlans: [
      { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 },
    ],
  });
  controller.state.ruleReview = {
    draftRows: [{
      id: 'rule-row',
      requirementId: 'req_rule',
      type: 'subject_preferred_periods',
      targetType: 'subject',
      targetId: 'math',
      targetName: 'Math',
      slots: ['1-1'],
      priority: 'soft',
      status: 'effective',
      rawText: 'Math should prefer Monday period 1',
      sourceSheet: 'AI约束建议',
      sourceRow: 2,
      parseSource: 'local_xlsx',
    }],
    requirementItems: [{
      id: 'req_rule',
      object: { kind: 'subject', name: 'Math', matchedIds: ['math'], scope: 'explicit' },
      intent: 'preferred_periods',
      status: 'actionable',
      applyTo: 'rule',
      parameters: { slots: ['1-1'] },
      source: { rawText: 'Math should prefer Monday period 1', sourceRow: 2 },
    }],
    semanticActions: [],
  };
  controller.state.constraintDialog = {
    open: true,
    selectedRequirementId: 'req_rule',
    editingConstraint: {
      ...controller.state.ruleReview.draftRows[0],
      originalId: 'rule-row',
    },
  };

  globalThis.alert = message => alerts.push(message);
  globalThis.document = {
    getElementById(id) {
      return {
        'tt-edit-constraint-type': { value: 'subject_preferred_periods' },
        'tt-edit-constraint-target': { value: 'subject:english' },
        'tt-edit-constraint-limit': { value: '' },
      }[id] || null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-edit-slot]:checked') {
        return [{ value: '2-2' }, { value: '2-3' }];
      }
      return [];
    },
  };

  try {
    controller.saveEditedConstraint();

    assert.deepEqual(alerts, []);
    assert.equal(controller.state.constraintDialog.editingConstraint, null);
    assert.deepEqual(controller.state.ruleReview.draftRows.map(row => ({
      id: row.id,
      requirementId: row.requirementId,
      type: row.type,
      targetType: row.targetType,
      targetId: row.targetId,
      targetName: row.targetName,
      slots: row.slots,
      priority: row.priority,
      status: row.status,
      rawText: row.rawText,
      sourceRow: row.sourceRow,
      parseSource: row.parseSource,
    })), [{
      id: 'rule-row',
      requirementId: 'req_rule',
      type: 'subject_preferred_periods',
      targetType: 'subject',
      targetId: 'english',
      targetName: 'English',
      slots: ['2-2', '2-3'],
      priority: 'soft',
      status: 'effective',
      rawText: 'Math should prefer Monday period 1',
      sourceRow: 2,
      parseSource: 'local_xlsx',
    }]);

    const html = renderWorkbench(sampleWorkbenchState({
      project: controller.state.project,
      ruleReview: controller.state.ruleReview,
      constraintDialog: { open: true, selectedRequirementId: 'req_rule' },
    }));
    assert.match(html, /English/);
    assert.match(html, /周二第2节、周二第3节/);
  } finally {
    globalThis.document = originalDocument;
    globalThis.alert = originalAlert;
  }
});

test('timetable Escape closes the constraint edit modal before the main dialog', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.constraintDialog = {
    open: true,
    editingConstraint: { id: 'rule-row', originalId: 'rule-row' },
  };
  const events = [];
  const event = {
    key: 'Escape',
    target: { matches: () => false, isContentEditable: false },
    preventDefault: () => events.push('preventDefault'),
    stopPropagation: () => events.push('stopPropagation'),
  };

  const handled = handleTimetableEscape(event, null, controller, controller.state);

  assert.equal(handled, true);
  assert.deepEqual(events, ['preventDefault', 'stopPropagation']);
  assert.equal(controller.state.constraintDialog.open, true);
  assert.equal(controller.state.constraintDialog.editingConstraint, null);
});

test('timetable constraint dialog confirms before deleting one machine rule', () => {
  const confirmations = [];
  const originalConfirm = globalThis.confirm;
  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.state.ruleReview = {
      draftRows: [{ id: 'rule-row', requirementId: 'req_rule', type: 'subject_morning', status: 'effective' }],
      requirementItems: [{
        id: 'req_rule',
        object: { kind: 'subject', name: '语文', matchedIds: ['s1'], scope: 'explicit' },
        intent: 'preferred_periods',
        status: 'actionable',
        applyTo: 'rule',
        source: { rawText: '语文尽量上午' },
      }],
      semanticActions: [{
        id: 'act_rule',
        requirementId: 'req_rule',
        kind: 'rules_patch',
        status: 'ready',
        target: { rowIds: 'rule-row' },
      }],
      excludedApplyItemKeys: ['rule:rule-row'],
    };
    controller.state.constraintDialog = { open: true, requirementFilter: 'rule', selectedRequirementId: '' };

    globalThis.confirm = message => {
      confirmations.push(message);
      return false;
    };
    controller.deleteConstraint('rule-row');
    assert.deepEqual(controller.state.ruleReview.draftRows.map(row => row.id), ['rule-row']);
    assert.deepEqual(controller.state.ruleReview.requirementItems.map(item => item.id), ['req_rule']);
    assert.deepEqual(controller.state.ruleReview.excludedApplyItemKeys, ['rule:rule-row']);

    globalThis.confirm = message => {
      confirmations.push(message);
      return true;
    };
    controller.deleteConstraint('rule-row');
    assert.deepEqual(controller.state.ruleReview.draftRows, []);
    assert.deepEqual(controller.state.ruleReview.requirementItems, []);
    assert.deepEqual(controller.state.ruleReview.semanticActions, []);
    assert.deepEqual(controller.state.ruleReview.excludedApplyItemKeys, []);
    assert.ok(confirmations.some(message => /删除这条规则/.test(message)));
  } finally {
    globalThis.confirm = originalConfirm;
  }
});

test('timetable constraint dialog keeps a requirement when deleting one rule leaves another semantic action', () => {
  const originalConfirm = globalThis.confirm;
  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.state.ruleReview = {
      draftRows: [{ id: 'rule-row', requirementId: 'req_mixed', type: 'subject_morning', status: 'effective' }],
      requirementItems: [{
        id: 'req_mixed',
        object: { kind: 'subject', name: '数学', matchedIds: ['math'], scope: 'explicit' },
        intent: 'block_preference',
        status: 'actionable',
        applyTo: 'lesson_plan',
        source: { rawText: '数学必须连堂，也尽量上午' },
      }],
      semanticActions: [{
        id: 'act_block',
        requirementId: 'req_mixed',
        kind: 'lesson_plan_patch',
        status: 'ready',
        payload: { blockPreference: 'double' },
      }],
      excludedApplyItemKeys: ['rule:rule-row', 'action:act_block'],
    };
    controller.state.constraintDialog = { open: true, requirementFilter: 'all', selectedRequirementId: 'req_mixed' };
    globalThis.confirm = () => true;

    controller.deleteConstraint('rule-row');

    assert.deepEqual(controller.state.ruleReview.draftRows, []);
    assert.deepEqual(controller.state.ruleReview.requirementItems.map(item => item.id), ['req_mixed']);
    assert.deepEqual(controller.state.ruleReview.semanticActions.map(action => action.id), ['act_block']);
    assert.deepEqual(controller.state.ruleReview.excludedApplyItemKeys, ['action:act_block']);
  } finally {
    globalThis.confirm = originalConfirm;
  }
});

test('timetable constraint dialog reserves semantic review height before legacy draft rows', async () => {
  const dialogStyles = await readFile(constraintDialogStylePath, 'utf8');
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'file',
      draftRows: [{
        id: 'legacy-draft-1',
        origin: 'user_input',
        rawText: '同一位教师同一时间只能给一个班上课。',
        type: 'teacher_unavailable',
        targetName: '全部教师',
        status: 'needs_review',
        warnings: ['缺少明确节次，请补充后再生效。'],
      }],
      warnings: [],
      conflicts: [],
      unsupportedItems: [],
      requirementItems: [{
        id: 'req_review',
        origin: 'user_input',
        rowId: 'legacy-draft-1',
        object: { kind: 'subject', name: '未知课程', matchedIds: [], scope: 'ambiguous' },
        intent: 'preferred_periods',
        status: 'needs_review',
        applyTo: 'review',
        parameters: { slots: ['1-1'] },
        source: { rawText: '未知课程第1节优先', sourceRow: 1 },
      }],
      semanticActions: [],
    },
    constraintDialog: { open: true },
  }));

  assert.match(html, /tt-requirement-workbench/);
  assert.match(html, /解析结果/);
  assert.match(html, /来自你的输入 1 条 · 系统补充 0 条/);
  assert.match(html, /落地结果/);
  assert.match(html, /data-constraint-id="legacy-draft-1"/);
  assert.match(html, /data-action="edit-constraint"/);
  assert.match(html, /data-action="delete-constraint"/);
  assert.doesNotMatch(html, /已识别约束/);
  assert.match(dialogStyles, /\.tt-requirement-workbench\s*{[\s\S]*--tt-requirement-review-height:\s*clamp/);
  assert.match(dialogStyles, /\.tt-requirement-workbench\s*{[\s\S]*grid-template-rows:\s*auto auto auto var\(--tt-requirement-review-height\)/);
  assert.match(dialogStyles, /\.tt-requirement-workbench\s*{[\s\S]*block-size:\s*calc\(var\(--tt-requirement-review-height\) \+ 118px\)/);
  assert.match(dialogStyles, /\.tt-requirement-review-layout\s*{[\s\S]*height:\s*var\(--tt-requirement-review-height\)/);
  assert.match(dialogStyles, /\.tt-requirement-table\s*{[\s\S]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/);
  assert.match(dialogStyles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-requirement-workbench\s*{[\s\S]*block-size:\s*auto/);
});

test('timetable constraint dialog folds draft-only constraints into understood requirements', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      draftRows: [{
        id: 'draft-only-1',
        origin: 'user_input',
        rawText: '数学尽量上午',
        type: 'subject_morning',
        targetType: 'subject',
        targetName: '数学',
        status: 'effective',
        confidence: 0.94,
        warnings: [],
      }, {
        id: 'draft-only-2',
        origin: 'user_input',
        rawText: '王老师周一前两节不排',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetName: '王老师',
        slots: ['1-1', '1-2'],
        status: 'needs_review',
        warnings: ['存在多个候选教师'],
      }],
      warnings: [],
      conflicts: [],
      unsupportedItems: [],
      requirementItems: [],
      semanticActions: [],
    },
    constraintDialog: { open: true },
  }));

  assert.match(html, /tt-requirement-workbench/);
  assert.match(html, /解析结果/);
  assert.match(html, /来自你的输入 2 条 · 系统补充 0 条/);
  assert.match(html, /王老师/);
  assert.match(html, /教师不可排/);
  assert.match(html, /落地结果/);
  assert.match(html, /data-constraint-id="draft-only-2"/);
  assert.match(html, /周一第1节、周一第2节/);
  assert.match(html, /应用需求 \(1\)/);
  assert.doesNotMatch(html, /tt-constraint-preview/);
  assert.doesNotMatch(html, /已识别约束/);
});

test('timetable constraint dialog can select synthesized draft requirement rows', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.ruleReview = {
    draftRows: [{
      id: 'draft-select-1',
      rawText: '数学尽量上午',
      type: 'subject_morning',
      targetName: '数学',
      status: 'effective',
    }, {
      id: 'draft-select-2',
      rawText: '王老师周一前两节不排',
      type: 'teacher_unavailable',
      targetName: '王老师',
      slots: ['1-1', '1-2'],
      status: 'needs_review',
    }],
    requirementItems: [],
    semanticActions: [],
  };
  controller.state.constraintDialog = { open: true, requirementFilter: 'all', selectedRequirementId: '' };

  controller.selectRequirement('draft_req_draft-select-1');

  assert.equal(controller.state.constraintDialog.selectedRequirementId, 'draft_req_draft-select-1');
});

test('timetable constraint dialog preserves legacy fallback when parse response omits sourceRequirements', async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;

  globalThis.document = {
    getElementById() {
      return null;
    },
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async text() {
      return JSON.stringify({
        success: true,
        data: {
          draftRows: [{
            id: 'legacy-row',
            requirementId: 'legacy-req',
            type: 'subject_morning',
            targetName: '数学',
            status: 'effective',
          }],
          requirementItems: [{
            id: 'legacy-req',
            intent: 'preferred_periods',
            status: 'actionable',
            applyTo: 'rule',
            source: { rawText: '数学尽量安排在上午。' },
          }],
          semanticActions: [],
        },
      });
    },
  });

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.detectConstraintConflicts = async () => {};
    controller.state.project = readyConstraintParseProject();
    controller.state.constraintDialog = { open: true, requirementFilter: 'all', selectedRequirementId: '' };
    controller.state.ruleReview = {
      inputMode: 'file',
      mode: 'file',
      sourceRequirements: [],
      draftRows: [],
      requirementItems: [],
      semanticActions: [],
    };
    controller.constraintDialogFile = new Blob(['legacy workbook']);

    await controller.parseConstraintsFromDialog();

    assert.equal(controller.state.constraintDialog.selectedRequirementId, 'legacy-req');
    assert.equal(controller.state.ruleReview.sourceRequirements, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
  }
});
test('timetable constraint dialog replaces previous xlsx parse results instead of appending', async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const responses = [
    {
      schemaVersion: 'timetable_constraints/v2',
      sourceRequirements: [{ sourceId: 'src:old', rawText: '语文上午', clauses: [] }],
      systemSupplements: [{ supplementId: 'sys:old' }],
      manualRequirements: [{ sourceId: 'manual:old' }],
      constraintIRs: [{ constraintId: 'clause:old', sourceId: 'src:old' }],
      statistics: { userInputCount: 1, clauseCount: 1 },
      warningItems: [{ id: 'warning-item:old' }],
      draftRows: [{ id: 'old-row', type: 'subject_morning', targetName: '语文', status: 'effective', parseSource: 'local_xlsx' }],
      requirementItems: [{ id: 'old-req', rowId: 'old-row', object: { kind: 'subject', name: '语文' }, intent: 'preferred_day_part', applyTo: 'rule', status: 'actionable', source: { rawText: '语文上午' } }],
      semanticActions: [{ id: 'old-action', requirementId: 'old-req', kind: 'rules_patch', target: { rowIds: ['old-row'] }, status: 'ready' }],
      unsupportedItems: [{ id: 'old-unsupported', type: 'teacher_load_balance' }],
      warnings: ['old-warning'],
    },
    {
      schemaVersion: 'timetable_constraints/v2.1',
      sourceRequirements: [{ sourceId: 'src:new', rawText: '数学上午', clauses: [] }],
      systemSupplements: [{ supplementId: 'sys:new' }],
      manualRequirements: [{ sourceId: 'manual:new' }],
      constraintIRs: [{ constraintId: 'clause:new', sourceId: 'src:new' }],
      statistics: { userInputCount: 1, clauseCount: 1, executableMachineRuleCount: 1 },
      warningItems: [{ id: 'warning-item:new' }],
      draftRows: [{ id: 'new-row', type: 'subject_morning', targetName: '数学', status: 'effective', parseSource: 'local_xlsx' }],
      requirementItems: [{ id: 'new-req', rowId: 'new-row', object: { kind: 'subject', name: '数学' }, intent: 'preferred_day_part', applyTo: 'rule', status: 'actionable', source: { rawText: '数学上午' } }],
      semanticActions: [{ id: 'new-action', requirementId: 'new-req', kind: 'rules_patch', target: { rowIds: ['new-row'] }, status: 'ready' }],
      unsupportedItems: [{ id: 'new-unsupported', type: 'block_protection' }],
      warnings: ['new-warning'],
    },
  ];
  let callIndex = 0;

  globalThis.document = {
    getElementById() {
      return null;
    },
  };
  globalThis.fetch = async url => {
    assert.equal(String(url), '/api/tools/timetable/rules/parse');
    const data = responses[callIndex++];
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      async text() {
        return JSON.stringify({ success: true, data });
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.detectConstraintConflicts = async () => {};
    controller.state.project = readyConstraintParseProject();
    controller.state.constraintDialog = { open: true, requirementFilter: 'all', selectedRequirementId: '' };
    controller.state.ruleReview = {
      inputMode: 'file',
      mode: 'file',
      draftRows: [],
      requirementItems: [],
      semanticActions: [],
      excludedApplyItemKeys: ['rule:stale-row'],
    };
    controller.constraintDialogFile = new Blob(['fake workbook']);

    await controller.parseConstraintsFromDialog();
    controller.constraintDialogFile = new Blob(['fake workbook again']);
    controller.state.ruleReview.excludedApplyItemKeys = ['rule:old-row'];
    await controller.parseConstraintsFromDialog();

    assert.equal(callIndex, 2);
    assert.deepEqual(controller.state.ruleReview.draftRows.map(row => row.id), ['new-row']);
    assert.deepEqual(controller.state.ruleReview.requirementItems.map(item => item.id), ['new-req']);
    assert.deepEqual(controller.state.ruleReview.semanticActions.map(action => action.id), ['new-action']);
    assert.deepEqual(controller.state.ruleReview.unsupportedItems.map(item => item.id), ['new-unsupported']);
    assert.deepEqual(controller.state.ruleReview.warnings, ['new-warning']);
    assert.equal(controller.state.ruleReview.schemaVersion, 'timetable_constraints/v2.1');
    assert.deepEqual(controller.state.ruleReview.sourceRequirements.map(item => item.sourceId), ['src:new']);
    assert.deepEqual(controller.state.ruleReview.systemSupplements.map(item => item.supplementId), ['sys:new']);
    assert.deepEqual(controller.state.ruleReview.manualRequirements.map(item => item.sourceId), ['manual:new']);
    assert.deepEqual(controller.state.ruleReview.constraintIRs.map(item => item.constraintId), ['clause:new']);
    assert.equal(controller.state.ruleReview.statistics.executableMachineRuleCount, 1);
    assert.deepEqual(controller.state.ruleReview.warningItems.map(item => item.id), ['warning-item:new']);
    assert.deepEqual(controller.state.ruleReview.excludedApplyItemKeys, []);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
  }
});

test('timetable constraint parsing progress does not rerender the spinner on timer ticks', async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let intervalCallback = null;
  let releaseFetch = null;
  let clearedInterval = false;

  globalThis.document = {
    getElementById() {
      return null;
    },
  };
  globalThis.setInterval = (callback, delay) => {
    assert.equal(delay, 300);
    intervalCallback = callback;
    return 'parse-progress-timer';
  };
  globalThis.clearInterval = timerId => {
    if (timerId === 'parse-progress-timer') clearedInterval = true;
  };
  globalThis.fetch = async url => {
    assert.equal(String(url), '/api/tools/timetable/rules/parse');
    await new Promise(resolve => {
      releaseFetch = resolve;
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      async text() {
        return JSON.stringify({
          success: true,
          data: {
            draftRows: [],
            requirementItems: [],
            semanticActions: [],
            warnings: [],
          },
        });
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    let renderCount = 0;
    controller.render = () => {
      renderCount += 1;
    };
    controller.detectConstraintConflicts = async () => {};
    controller.state.project = readyConstraintParseProject();
    controller.state.constraintDialog = { open: true, requirementFilter: 'all', selectedRequirementId: '' };
    controller.state.ruleReview = {
      inputMode: 'file',
      mode: 'file',
      draftRows: [],
      requirementItems: [],
      semanticActions: [],
    };
    controller.constraintDialogFile = new Blob(['fake workbook']);

    const parsePromise = controller.parseConstraintsFromDialog();
    assert.equal(renderCount, 1);
    assert.equal(typeof intervalCallback, 'function');
    assert.equal(typeof releaseFetch, 'function');

    intervalCallback();
    intervalCallback();
    assert.equal(controller.state.ruleReview.parseProgress, 20);
    assert.equal(renderCount, 1);

    releaseFetch();
    await parsePromise;

    assert.equal(clearedInterval, true);
    assert.equal(renderCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test('timetable constraint dialog controller exposes the current dialog actions', async () => {
  const controllerSource = await readFile(new URL('../public/js/tools/timetable/controller.js', import.meta.url), 'utf8');
  const dialogControllerSource = await readFile(new URL('../public/js/tools/timetable/controller-constraint-dialog.js', import.meta.url), 'utf8');
  const interactionSource = await readFile(new URL('../public/js/tools/timetable/grid-interactions.js', import.meta.url), 'utf8');
  const dialogViewSource = await readFile(new URL('../public/js/tools/timetable/view-constraint-dialog.js', import.meta.url), 'utf8');
  const statusDictionarySource = await readFile(new URL('../public/js/tools/timetable/constraint-status-dict.js', import.meta.url), 'utf8');

  assert.match(controllerSource, /openConstraintDialog\(/);
  assert.match(dialogControllerSource, /closeConstraintDialog\(/);
  assert.match(dialogControllerSource, /parseConstraintsFromDialog\(/);
  assert.match(dialogControllerSource, /applyConstraintsFromDialog\(/);
  assert.match(dialogControllerSource, /filterRequirements\(/);
  assert.match(dialogControllerSource, /selectRequirement\(/);
  assert.match(dialogControllerSource, /result\.draftRows/);
  assert.match(controllerSource, /this\.constraintDialogFile\s*=\s*null/);
  assert.match(dialogControllerSource, /fileInput\?\.files\?\.\[0\]\s*\|\|\s*this\.constraintDialogFile/);
  assert.match(dialogControllerSource, /this\.constraintDialogFile\s*=\s*file/);
  assert.match(interactionSource, /open-constraint-dialog/);
  assert.match(interactionSource, /close-constraint-dialog/);
  assert.match(interactionSource, /switch-constraint-mode/);
  assert.match(interactionSource, /parse-constraints/);
  assert.match(interactionSource, /apply-constraints/);
  assert.match(interactionSource, /filter-requirements/);
  assert.match(interactionSource, /select-requirement/);
  assert.match(interactionSource, /start-ai-chat/);
  assert.doesNotMatch(dialogControllerSource, /useConstraintExample/);
  assert.doesNotMatch(interactionSource, /use-example/);
  assert.doesNotMatch(dialogViewSource, /QUICK_CONSTRAINT_EXAMPLES|tt-quick-examples|tt-example-chip/);
  assert.doesNotMatch(statusDictionarySource, /QUICK_CONSTRAINT_EXAMPLES|CONSTRAINT_EXAMPLE_GROUPS/);
  assert.match(dialogViewSource, /class="tt-requirement-choice-chip"/);
});

function buttonTag(html, marker) {
  const markerIndex = html.indexOf(marker);
  assert.notEqual(markerIndex, -1, `expected button marker ${marker}`);
  const start = html.lastIndexOf('<button', markerIndex);
  const end = html.indexOf('>', markerIndex);
  assert.ok(start >= 0 && end > start, `expected button tag for ${marker}`);
  return html.slice(start, end + 1);
}

function extractMethodSource(source, methodName) {
  const signature = `async ${methodName}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `expected method ${methodName}`);
  const paramsEnd = source.indexOf(') {', start);
  assert.notEqual(paramsEnd, -1, `expected parameter list end for ${methodName}`);
  const bodyStart = source.indexOf('{', paramsEnd);
  assert.notEqual(bodyStart, -1, `expected method body for ${methodName}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  assert.fail(`unable to extract method ${methodName}`);
}

function createPeriodTimeDom(rows, settings = {}, segments = {}) {
  const createSelect = (value = '', options = []) => ({
    value: String(value ?? ''),
    disabled: false,
    options: options.map(option => ({ ...option })),
  });
  const settingInputs = new Map([
    ['#tt-period-start-time', { value: settings.startTime || '08:00' }],
    ['#tt-period-class-minutes', { value: String(settings.classMinutes ?? 40) }],
    ['#tt-period-break-minutes', { value: String(settings.breakMinutes ?? 10) }],
    ['#tt-period-afternoon-start-period', createSelect(
      settings.afternoonStartPeriod === undefined ? '' : String(settings.afternoonStartPeriod ?? ''),
      [{ value: '', label: '不单独拆分下午' }],
    )],
    ['#tt-period-afternoon-start-time', { value: settings.afternoonStartTime || '14:00' }],
    ['#tt-period-evening-start-period', createSelect(
      settings.eveningStartPeriod === undefined ? '' : String(settings.eveningStartPeriod ?? ''),
      [{ value: '', label: '不启用晚间' }],
    )],
    ['#tt-period-evening-start-time', { value: settings.eveningStartTime || '19:00', disabled: !settings.eveningStartPeriod }],
    ['#tt-segment-global-class-minutes', { value: String(settings.classMinutes ?? 45) }],
    ['#tt-segment-global-break-minutes', { value: String(settings.breakMinutes ?? 10) }],
  ]);
  const formatFixtureSegmentMeta = (seg, index) => {
    const kind = seg.datasetKind || seg.kind || '';
    const typeLabel = kind === 'teaching' ? '正式节次' : '附加时段';
    const parts = [`时段${index + 1}`, typeLabel];
    if (kind === 'teaching') parts.push(`${seg.periodCount || 0}节`);
    if (kind === 'duty') parts.push('值班');
    return parts.join(' · ');
  };
  const segmentCards = Object.entries(segments).map(([id, seg], index) => {
    const inputs = {
      label: { value: seg.label || '时段' },
      startTime: { value: seg.startTime || '08:00' },
      periodCount: { value: String(seg.periodCount || 1) },
      classMinutes: { value: seg.classMinutes === null ? '' : String(seg.classMinutes || '') },
      breakMinutes: { value: seg.breakMinutes === null ? '' : String(seg.breakMinutes || '') },
      kind: { value: seg.inputKind ?? (seg.kind === undefined ? '' : String(seg.kind || '')) },
      dutyEnabled: { checked: seg.dutyEnabled ?? String(seg.kind || '') === 'duty' },
    };
    const segmentIndex = { textContent: seg.metaText || formatFixtureSegmentMeta(seg, index) };
    const dutyStatus = { textContent: inputs.dutyEnabled.checked ? '开启' : '关闭' };
    return {
      dataset: { segmentId: id, segmentKind: seg.datasetKind || seg.kind || '' },
      className: 'tt-segment-card',
      inputs,
      segmentIndex,
      dutyStatus,
      querySelector(selector) {
        if (selector === '.tt-segment-index') return segmentIndex;
        if (selector === '[data-segment-duty-status]') return dutyStatus;
        if (selector.includes(`${id}-label`)) return inputs.label;
        if (selector.includes(`${id}-startTime`)) return inputs.startTime;
        if (selector.includes(`${id}-periodCount`)) return inputs.periodCount;
        if (selector.includes(`${id}-classMinutes`)) return inputs.classMinutes;
        if (selector.includes(`${id}-breakMinutes`)) return inputs.breakMinutes;
        if (selector.includes(`${id}-kind`)) return inputs.kind;
        if (selector.includes(`${id}-dutyEnabled`)) return inputs.dutyEnabled;
        return null;
      },
    };
  });
  const backgroundSegmentNodes = (settings.backgroundSegmentIds || []).map(id => ({
    dataset: { segmentId: id },
    className: 'tt-period',
    querySelector() {
      return null;
    },
  }));
  const createElement = tagName => ({
    tagName: String(tagName).toUpperCase(),
    className: '',
    colSpan: undefined,
    textContent: '',
    parentNode: null,
    children: [],
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    querySelector(selector) {
      if (selector === 'strong') {
        return this.children.find(child => child.tagName === 'STRONG')
          || this.children.flatMap(child => child.children || []).find(child => child.tagName === 'STRONG')
          || null;
      }
      return null;
    },
    remove() {
      if (!this.parentNode?.children) return;
      const index = this.parentNode.children.indexOf(this);
      if (index >= 0) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    },
  });
  const fakeDocument = { createElement };
  const tableBody = {
    ownerDocument: fakeDocument,
    children: [],
    querySelectorAll(selector) {
      if (selector === '.tt-period-time-segment-header') {
        return this.children.filter(child => child.className === 'tt-period-time-segment-header');
      }
      return [];
    },
    insertBefore(node, referenceNode) {
      node.parentNode = this;
      const index = this.children.indexOf(referenceNode);
      if (index >= 0) this.children.splice(index, 0, node);
      else this.children.push(node);
      return node;
    },
  };
  const createSegmentHeader = label => {
    const header = createElement('tr');
    header.className = 'tt-period-time-segment-header';
    const cell = createElement('td');
    cell.colSpan = 4;
    const strong = createElement('strong');
    strong.textContent = label;
    cell.appendChild(strong);
    header.appendChild(cell);
    return header;
  };
  const rowNodes = rows.map(row => {
    const startInput = { value: row.start || '' };
    const endInput = { value: row.end || '' };
    const gapInput = row.gapAfter === undefined
      ? null
      : { value: String(row.gapAfter), dataset: { periodTimeGapAfter: String(row.period) } };
    return {
      dataset: { periodTimeRow: String(row.period) },
      startInput,
      endInput,
      gapInput,
      querySelector(selector) {
        if (selector.includes('data-period-time-draft-start') || selector.includes('data-period-time-start')) return startInput;
        if (selector.includes('data-period-time-draft-end') || selector.includes('data-period-time-end')) return endInput;
        if (selector.includes('data-period-time-gap-after')) return gapInput;
        return null;
      },
    };
  });
  rowNodes.forEach(row => {
    row.parentNode = tableBody;
    tableBody.children.push(row);
  });
  const timeBlockRowNodes = (settings.timeBlockRows || []).map(row => {
    const startInput = { value: row.start || '', dataset: { periodTimeBlockStart: String(row.id) } };
    const endInput = { value: row.end || '', dataset: { periodTimeBlockEnd: String(row.id) } };
    return {
      dataset: { periodTimeBlockRow: String(row.id) },
      startInput,
      endInput,
      querySelector(selector) {
        if (selector.includes('data-period-time-block-start')) return startInput;
        if (selector.includes('data-period-time-block-end')) return endInput;
        return null;
      },
    };
  });
  const nonformalPreviewSlot = { innerHTML: settings.nonformalPreviewHtml || '' };
  const periodTimeTableBodySlot = { innerHTML: settings.timelineHtml || '' };
  return {
    rows: rowNodes,
    timeBlockRows: timeBlockRowNodes,
    segmentCards,
    settings: settingInputs,
    tableBody,
    nonformalPreviewSlot,
    periodTimeTableBodySlot,
    createSegmentHeader,
    querySelector(selector) {
      if (selector === '.tt-period-time-table tbody') return tableBody;
      if (selector === '[data-period-time-table-body-slot]') return periodTimeTableBodySlot;
      if (selector === '[data-nonformal-time-preview-slot]') return nonformalPreviewSlot;
      if (selector.includes('[data-segment-field=')) {
        return segmentCards
          .map(card => card.querySelector(selector))
          .find(Boolean) || null;
      }
      return settingInputs.get(selector) || null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-period-time-row]') return rowNodes;
      if (selector === '[data-period-time-block-row]') return timeBlockRowNodes;
      if (selector === '.tt-segment-card[data-segment-id]' || selector === '[data-period-time-segment-card]') return segmentCards;
      if (selector === '[data-segment-id]') return [...segmentCards, ...backgroundSegmentNodes];
      return [];
    },
  };
}

test('timetable roster stats count multi-teacher plans and allowed rooms', () => {
  const project = createDefaultTimetableProject({
    teachers: [
      { id: 't_math', name: 'Math Teacher', subjects: ['science'], unavailableSlots: [] },
      { id: 't_lab', name: 'Lab Teacher', subjects: ['science'], unavailableSlots: [] },
    ],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'science', name: 'Science', priority: 80, color: '#0891b2' }],
    lessonPlans: [{
      id: 'lp_science',
      classId: 'c1',
      subjectId: 'science',
      teacherId: 't_math',
      teacherIds: ['t_math', 't_lab'],
      weeklyHours: 4,
      roomId: 'lab_a',
      allowedRoomIds: ['lab_a', 'lab_b'],
    }],
  });

  const stats = getRosterStats(project);

  assert.equal(stats.fixedRoomCount, 2);
  assert.equal(stats.issueCount, 0);

  const invalidStats = getRosterStats({
    ...project,
    lessonPlans: [{
      ...project.lessonPlans[0],
      teacherIds: ['t_math', 'missing_teacher'],
    }],
  });
  assert.equal(invalidStats.issueCount, 1);
});

test('timetable frontend export names include published timetable files', () => {
  assert.equal(exportName('published_class'), '正式班级课表');
  assert.equal(exportName('published_teacher'), '正式教师课表');
  assert.equal(exportName('published_master'), '正式总课表');
});

test('timetable manual rule builder creates teacher limit review rows', () => {
  const rows = buildManualRuleDraftRows({
    type: 'teacher_daily_limit',
    targetType: 'teacher',
    targets: [{ id: 't_math', name: 'Math Teacher' }],
    days: [1, 2],
    periods: [1, 2],
    limit: 4,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'teacher_daily_limit');
  assert.equal(rows[0].targetId, 't_math');
  assert.equal(rows[0].limit, 4);
  assert.deepEqual(rows[0].slots, []);
  assert.equal(rows[0].priority, 'soft');
});

test('timetable planner is assembled from workbench modules', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const expectedModules = [
    'api.js',
    'controller.js',
    'forms.js',
    'grid-interactions.js',
    'selectors.js',
    'state.js',
    'view.js',
  ];

  assert.match(source, /import\s+\{\s*TimetablePlannerController\s*\}\s+from\s+['"]\.\/timetable\/controller\.js['"]/);
  assert.doesNotMatch(source, /class\s+TimetablePlanner\s*{/);

  for (const moduleName of expectedModules) {
    const moduleSource = await readFile(new URL(moduleName, moduleRoot), 'utf8');
    assert.match(moduleSource, /export\s+/);
  }
});

test('timetable immersive mode hides global click particles without affecting seating', async () => {
  const controller = new TimetablePlannerController();
  const classes = new Set();
  const host = {
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
    },
  };
  const container = {
    closest: selector => selector === '.tool-container' ? host : null,
  };
  controller.load = async () => {};

  await controller.init(container);
  assert.equal(classes.has('tool-container--timetable'), true);

  controller.destroy();
  assert.equal(classes.has('tool-container--timetable'), false);

  const styles = await readFile(stylePath, 'utf8');
  assert.match(styles, /\.tool-container--timetable\.active\s*~\s*\.math-particle-dom/);
});

test('timetable planner uses the seating-style control panel and board layout', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  const viewSource = await readFile(new URL('view.js', moduleRoot), 'utf8');

  assert.match(viewSource, /class="tt-workbench \$\{/);
  assert.match(viewSource, /class="tt-topbar"/);
  assert.match(viewSource, /class="tt-sidebar"/);
  assert.match(viewSource, /class="tt-schedule-panel"/);
  assert.match(viewSource, /const inspectorClass/);
  assert.match(viewSource, /class="\$\{inspectorClass\}"/);
  assert.match(viewSource, /id="tt-inspector-drawer"/);
  assert.match(viewSource, /class="tt-inspector-summary"/);
  assert.match(viewSource, /data-inspector-floating-window/);
  assert.match(viewSource, /data-inspector-drag-handle/);
  assert.match(viewSource, /data-inspector-toggle-icon/);
  assert.match(viewSource, /data-workflow-step="data"/);
  assert.match(viewSource, /data-workflow-step="rules"/);
  assert.match(viewSource, /data-workflow-step="solve"/);
  assert.match(viewSource, /data-workflow-step="review"/);
  assert.doesNotMatch(viewSource, /id:\s*'agent'/);
  assert.match(viewSource, /renderWorkbench/);
  assert.match(viewSource, /renderSchedulePanel/);
  assert.match(viewSource, /renderInspector/);
  assert.doesNotMatch(source, /class="tt-tabs"/);
  assert.doesNotMatch(source, /renderTab\(/);
  assert.doesNotMatch(source, /renderActiveTab/);

  assert.match(styles, /\.tt-workbench\s*{/);
  assert.match(styles, /\.tt-workbench\s*{[^}]*grid-template-areas:\s*"topbar topbar"\s*"sidebar schedule"/s);
  assert.doesNotMatch(styles, /\.tt-workbench\s*{[^}]*"sidebar schedule inspector"/s);
  assert.match(styles, /\.tt-sidebar\s*{[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.tt-schedule-scroll\s*{[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.tt-inspector\s*{[^}]*position:\s*fixed/s);
  assert.match(styles, /\.tt-inspector\s*{[^}]*top:\s*88px/s);
  assert.match(styles, /\.tt-inspector\s*{[^}]*right:\s*24px/s);
  assert.match(styles, /\.tt-inspector\.is-positioned\s*{[^}]*left:\s*var\(--tt-inspector-x\)/s);
  assert.match(styles, /\.tt-inspector-drawer\s*{[^}]*border-radius:\s*var\(--tt-radius-lg\)/s);
  assert.match(styles, /--tt-bg-base:\s*#0f172a/);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.tt-workbench\s*{[^}]*grid-template-areas:\s*"topbar"\s*"sidebar"\s*"schedule"\s*"inspector"/s);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.tt-inspector[\s\S]*position:\s*static/s);
});

test('timetable inspector supports draggable floating window persistence', async () => {
  const stateSource = await readFile(new URL('state.js', moduleRoot), 'utf8');
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(stateSource, /inspectorPosition:\s*null/);
  assert.match(controllerSource, /loadInspectorPosition\(/);
  assert.match(interactionSource, /timetable\.inspector\.position\.v1/);
  assert.match(interactionSource, /data-inspector-drag-handle/);
  assert.match(interactionSource, /pointerdown/);
  assert.match(interactionSource, /saveInspectorPosition\(/);
  assert.match(interactionSource, /clampInspectorPosition\(/);
  assert.match(styles, /\.tt-inspector\.is-collapsed\s*{[^}]*width:\s*min\(184px,\s*calc\(100vw - 48px\)\)/s);
  assert.match(styles, /\.tt-inspector-body\s*{[^}]*max-height:\s*calc\(100vh - 150px\)/s);
});

test('timetable inspector clamps and persists floating position safely', () => {
  const storage = new Map();
  const localStorageLike = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
  };

  const clamped = clampInspectorPosition(
    { x: -20, y: 900 },
    { width: 800, height: 600 },
    { width: 360, height: 420 },
  );
  assert.deepEqual(clamped, { x: 12, y: 168 });

  saveInspectorPosition({ x: 123.4, y: 88.9 }, localStorageLike);
  assert.deepEqual(loadInspectorPosition(localStorageLike), { x: 123, y: 89 });

  storage.set('timetable.inspector.position.v1', '{"x":"bad","y":20}');
  assert.equal(loadInspectorPosition(localStorageLike), null);
});

test('timetable inspector drag updates state and localStorage', () => {
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const stored = new Map();
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 800,
    matchMedia() {
      return { matches: true };
    },
  };
  globalThis.localStorage = {
    getItem(key) {
      return stored.get(key) || null;
    },
    setItem(key, value) {
      stored.set(key, value);
    },
  };

  const listeners = {};
  const ownerDocument = {
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    removeEventListener(type, listener) {
      if (listeners[type] === listener) delete listeners[type];
    },
  };
  const classNames = new Set();
  const inspector = {
    classList: {
      add(name) {
        classNames.add(name);
      },
      remove(name) {
        classNames.delete(name);
      },
      toggle(name, force) {
        if (force) classNames.add(name);
        else classNames.delete(name);
      },
      contains(name) {
        return classNames.has(name);
      },
    },
    style: {
      values: new Map(),
      setProperty(name, value) {
        this.values.set(name, value);
      },
    },
    getBoundingClientRect() {
      return { left: 820, top: 88, width: 360, height: 420 };
    },
  };
  const drawer = {
    open: true,
    addEventListener(type, listener) {
      listeners[`drawer:${type}`] = listener;
    },
  };
  const handleListeners = {};
  const handle = {
    dataset: {},
    ownerDocument,
    addEventListener(type, listener) {
      handleListeners[type] = listener;
    },
  };
  const container = {
    addEventListener() {},
    querySelector(selector) {
      if (selector === '[data-inspector-floating-window]') return inspector;
      if (selector === '#tt-inspector-drawer') return drawer;
      if (selector === '[data-inspector-drag-handle]') return handle;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const state = { inspectorOpen: true, inspectorPosition: null };

  try {
    bindGridInteractions(container, {}, state);
    handleListeners.pointerdown({
      button: 0,
      clientX: 900,
      clientY: 120,
      target: { closest: () => null },
    });
    listeners.pointermove({
      clientX: 760,
      clientY: 220,
      preventDefault() {},
    });
    listeners.pointerup({});

    assert.deepEqual(state.inspectorPosition, { x: 680, y: 188 });
    assert.equal(inspector.style.values.get('--tt-inspector-x'), '680px');
    assert.equal(inspector.style.values.get('--tt-inspector-y'), '188px');
    assert.equal(stored.get('timetable.inspector.position.v1'), '{"x":680,"y":188}');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('timetable planner no longer renders the legacy floating smart agent', async () => {
  const html = renderWorkbench(sampleWorkbenchState({
    agent: {
      sessionId: 'tt_agent_demo',
      stage: 'solve_planning',
      messages: [
        { role: 'user', content: '开始排课' },
        { role: 'assistant', content: '我已生成求解计划，确认后才会调用求解器。' },
      ],
      plan: [],
      questions: [{ id: 'q_missing', title: '需要补充', description: '请补充教师名单' }],
      approvalQueue: [
        {
        id: 'act_solve',
        type: 'execute_solve',
        title: '执行求解计划',
        description: '确认后才会调用本地排课算法/Timefold。',
        },
        {
          id: 'act_save_recommended',
          type: 'save_solution',
          title: 'save recommended solution',
          description: 'save the Timefold candidate',
          recommended: true,
          payload: {
            solutionId: 'timefold',
            diff: { addedSlots: 3, removedSlots: 0, slotDelta: 3 },
          },
        },
        {
          id: 'act_save_candidate',
          type: 'save_solution',
          title: 'save candidate solution',
          description: 'save the local candidate',
          recommended: false,
          payload: {
            solutionId: 'local',
            diff: { addedSlots: 3, removedSlots: 0, slotDelta: 3 },
          },
        },
      ],
      artifacts: [
        { id: 'a_plan', type: 'solve_plan', title: '求解计划', solverPreference: 'local_only' },
        {
          id: 'a_solution',
          type: 'solve_result',
          title: '排课方案',
          score: { hardViolationCount: 0 },
          bestSolution: { id: 'timefold' },
          comparison: [
            { id: 'local', name: '本地快速方案', solverUsed: 'local_scheduler', totalScore: 82, hardViolationCount: 0 },
            { id: 'timefold', name: 'Timefold 优化方案', solverUsed: 'timefold', totalScore: 88, hardViolationCount: 0 },
          ],
          savePreview: {
            diff: {
              before: { slotCount: 0 },
              after: { slotCount: 3 },
              addedSlots: 3,
              removedSlots: 0,
              slotDelta: 3,
              unplacedDelta: 0,
            },
          },
        },
        {
          id: 'a_export',
          type: 'export_result',
          title: 'export links',
          summary: 'saved and ready to export',
          exportLinks: [
            { type: 'class', label: 'class timetable' },
            { type: 'teacher', label: 'teacher timetable' },
          ],
        },
      ],
      loading: false,
      error: null,
      input: '',
      nextAction: 'await_approval',
    },
  }));

  assert.doesNotMatch(html, /data-workflow-step="agent"/);
  assert.doesNotMatch(html, /id="tt-agent-floating"/);
  assert.doesNotMatch(html, /class="tt-agent-toggle"/);
  assert.doesNotMatch(html, /class="tt-agent-floating-panel"/);
  assert.doesNotMatch(html, /id="tt-timetable-agent-panel"/);
  assert.match(html, /id="tt-open-rule-review"/);
});

test('timetable smart agent frontend calls additive agent APIs without touching seating modules', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const apiSource = await readFile(new URL('api.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');
  const constraintDialogStyles = await readFile(constraintDialogStylePath, 'utf8');

  assert.match(apiSource, /requestTimetableAgent/);
  assert.match(controllerSource, /startTimetableAgentSession/);
  assert.match(controllerSource, /sendTimetableAgentMessage/);
  assert.match(controllerSource, /requestTimetableAgent\('\/session'/);
  assert.match(controllerSource, /requestTimetableAgent\('\/message'/);
  assert.match(controllerSource, /requestTimetableAgent\('\/approve'/);
  assert.match(controllerSource, /buildSmartSolvePlan/);
  assert.match(controllerSource, /solvePlan:\s*{/);
  assert.match(controllerSource, /planner/);
  assert.match(interactionSource, /timetable-agent-start/);
  assert.match(interactionSource, /timetable-agent-approve/);
  assert.doesNotMatch(interactionSource, /#tt-agent-floating/);
  assert.doesNotMatch(interactionSource, /state\.agentOpen = Boolean\(event\.target\.open\)/);
  assert.doesNotMatch(styles, /\.tt-agent-panel\s*{/);
  assert.doesNotMatch(styles, /\.tt-agent-floating\s*{/);
  assert.doesNotMatch(styles, /\.tt-agent-toggle\s*{/);
  assert.doesNotMatch(styles, /\.tt-agent-floating-panel\s*{/);
  assert.match(constraintDialogStyles, /\.tt-constraint-dialog\s*{/);
  assert.match(constraintDialogStyles, /\.tt-constraint-preview\s*{/);
  assert.match(constraintDialogStyles, /\.tt-constraint-list\s*{/);
  assert.doesNotMatch(constraintDialogStyles, /\.tt-agent-floating\s*{/);
  assert.doesNotMatch(controllerSource, /seating/i);
});

test('timetable master schedule renderer indexes slots instead of rescanning for every cell', async () => {
  const viewSource = await readFile(new URL('view.js', moduleRoot), 'utf8');

  assert.match(viewSource, /createScheduleRenderContext/);
  assert.match(viewSource, /slotsByCell/);
  assert.match(viewSource, /function renderScheduleCell\(state,\s*context,\s*day,\s*period\)/);
  assert.doesNotMatch(viewSource, /function renderScheduleCell\(state,\s*day,\s*period\)[\s\S]*getSlotsAt/);
  assert.doesNotMatch(viewSource, /function renderSlot\(state,\s*slot\)[\s\S]*getSlotDetails/);
});

test('timetable interactions bind delegated hot-path listeners only once', async () => {
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');

  assert.match(interactionSource, /__ttDelegatedInteractionsBound/);
  assert.match(interactionSource, /function bindDelegatedInteractions\(container\)/);
  assert.match(interactionSource, /if \(container\.__ttDelegatedInteractionsBound\) return;/);
  assert.match(interactionSource, /container\.__ttController = controller;/);
  assert.match(interactionSource, /container\.addEventListener\('dragstart'/);
  assert.match(interactionSource, /container\.addEventListener\('drop'/);
  assert.doesNotMatch(interactionSource, /querySelectorAll\('\.tt-slot'\)/);
  assert.doesNotMatch(interactionSource, /querySelectorAll\('\.tt-cell'\)/);
});

test('timetable styles mirror the seating planner theme and font system', async () => {
  const styles = await readFile(stylePath, 'utf8');

  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-bg-page:\s*transparent/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-primary:\s*#0891b2/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-primary-hover:\s*#06b6d4/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-primary-glow:\s*0 0 20px rgba\(8,\s*145,\s*178,\s*0\.35\)/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-bg-base:\s*#0f172a/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-bg-panel:\s*rgba\(30,\s*41,\s*59,\s*0\.85\)/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-bg-input:\s*rgba\(15,\s*23,\s*42,\s*0\.6\)/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-border:\s*rgba\(148,\s*163,\s*184,\s*0\.15\)/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-radius-lg:\s*16px/s);
  assert.match(styles, /body\.light-mode\s+\.tt-workbench\s*{[^}]*--tt-bg-panel:\s*rgba\(255,\s*255,\s*255,\s*0\.9\)/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*font-family:\s*var\(--font-heading/s);
  assert.match(styles, /\.tt-import-text\s*{[^}]*font-family:\s*inherit/s);
  assert.match(styles, /\.tt-topbar\s*{[^}]*display:\s*flex/s);
  assert.match(styles, /\.tt-topbar\s*{[^}]*flex-wrap:\s*wrap/s);
  assert.match(styles, /\.tt-topbar\s*{[^}]*background:\s*var\(--tt-bg-panel\)/s);
  assert.match(styles, /\.tt-topbar\s*{[^}]*border-radius:\s*var\(--tt-radius-md\)/s);
  assert.match(styles, /\.tt-sidebar,[\s\S]*?\.tt-schedule-panel\s*{[^}]*border-radius:\s*var\(--tt-radius-lg\)/s);
  assert.match(styles, /\.tt-inspector-drawer\s*{[^}]*border-radius:\s*var\(--tt-radius-lg\)/s);
  assert.match(styles, /\.tt-btn,[\s\S]*?\.tt-icon-btn\s*{[^}]*transition:\s*all var\(--tt-transition-fast\)/s);
  assert.match(styles, /\.tt-chip\s*{[^}]*background:\s*rgba\(148,\s*163,\s*184,\s*0\.1\)/s);

  assert.doesNotMatch(styles, /--tt-bg-page:\s*#f6f7f9/i);
  assert.doesNotMatch(styles, /--tt-bg-page:\s*#111827/i);
  assert.doesNotMatch(styles, /--tt-bg-panel:\s*var\(--glass-panel/i);
  assert.doesNotMatch(styles, /--tt-shadow:\s*var\(--shadow-depth/i);
  assert.doesNotMatch(styles, /var\(--accent-gradient/i);
  assert.doesNotMatch(styles, /var\(--font-mono/i);
  assert.doesNotMatch(styles, /body:not\(\.light-mode\)\s+\.tt-workbench/);
});

test('timetable planner keeps schedule operations inside the board surface', async () => {
  const viewSource = await readFile(new URL('view.js', moduleRoot), 'utf8');
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');

  assert.match(viewSource, /id="tt-run-schedule"/);
  assert.match(viewSource, /id="tt-owner-select"/);
  assert.match(viewSource, /data-view-mode="class"/);
  assert.match(viewSource, /data-view-mode="teacher"/);
  assert.match(viewSource, /data-view-mode="master"/);
  assert.match(viewSource, /id="tt-lock-selected"/);
  assert.match(viewSource, /id="tt-clear-selected"/);
  assert.match(viewSource, /data-export-type="class"/);
  assert.match(viewSource, /data-export-type="teacher"/);
  assert.match(viewSource, /data-export-type="master"/);
  assert.match(viewSource, /data-export-type="plans"/);
  assert.match(viewSource, /连堂/);
  assert.match(viewSource, /旧课表已保留/);
  assert.match(controllerSource, /normalizeApiError/);
  assert.match(interactionSource, /bindGridInteractions/);
  assert.match(interactionSource, /blockId/);
});

test('timetable controller clears stale optimization jobs after saved data changes', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const mutatingMethods = [
    'saveProject',
    'importRoster',
    'saveRules',
    'adjustSlot',
    'confirmRestoreSchedule',
    'confirmPublishSchedule',
  ];

  for (const methodName of mutatingMethods) {
    assert.match(
      controllerSource,
      new RegExp(`async\\s+${methodName}\\([^)]*\\)\\s*{[\\s\\S]*?this\\.clearOptimizationPolling\\(\\);[\\s\\S]*?this\\.state\\.solverJob\\s*=\\s*null;`),
    );
  }
});

test('timetable workbench keeps solving in the board and failure summaries in the inspector', async () => {
  const viewSource = await readFile(new URL('view.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');
  const state = sampleWorkbenchState({
    lastFailure: {
      reason: 'timeout',
      message: 'Timefold 求解超时，旧课表已保留。',
      solverStats: { lessonCount: 3, timeoutSeconds: 660, durationMs: 660000 },
    },
  });
  const schedulePanel = renderSchedulePanel(state);
  const inspector = renderInspector(state);

  assert.match(viewSource, /class="tt-schedule-actions"/);
  assert.match(viewSource, /id="tt-run-schedule"/);
  assert.match(viewSource, /renderEmptyScheduleGrid/);
  assert.match(viewSource, /renderUnscheduledPlanQueue/);
  assert.doesNotMatch(schedulePanel, /class="tt-plan-queue"/);
  assert.match(schedulePanel, /class="tt-schedule-grid"/);
  assert.match(schedulePanel, /data-period="1"/);
  assert.match(schedulePanel, /data-period="7"/);
  assert.doesNotMatch(inspector, /class="tt-plan-queue"/);
  assert.match(inspector, /生成详情/);
  assert.match(inspector, /Timefold 求解超时/);

  assert.match(styles, /\.tt-schedule-body\s*{/);
  assert.match(styles, /\.tt-schedule-body\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(styles, /\.tt-schedule-body\s*{[^}]*align-items:\s*start/s);
  assert.match(styles, /\.tt-schedule-body\s*{[^}]*width:\s*100%/s);
  assert.match(styles, /\.tt-schedule-grid\s*{[^}]*align-self:\s*stretch/s);
  assert.match(styles, /\.tt-schedule-grid\s*{[^}]*justify-self:\s*stretch/s);
  assert.match(styles, /\.tt-schedule-grid\s*{[^}]*width:\s*100%/s);
  assert.match(styles, /\.tt-schedule-grid\s*{[^}]*min-width:\s*max\(calc\(96px \+ var\(--tt-days,\s*5\) \* 126px\),\s*100%\)/s);
  assert.match(styles, /\.tt-schedule-grid\s*{[^}]*grid-auto-rows:\s*minmax\(72px,\s*auto\)/s);
  assert.match(styles, /\.tt-grid-head\s*{[^}]*min-height:\s*36px/s);
  assert.match(styles, /\.tt-plan-queue\s*{/);
  assert.match(styles, /\.tt-main-empty-cell\s*{/);
});

test('timetable schedule grid shows configured period times beside period labels', () => {
  const state = sampleWorkbenchState();
  state.project = createDefaultTimetableProject({
    activeWeekdays: [1, 2],
    activePeriods: [1, 2],
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    periodTimes: [
      { period: 1, start: '08:00', end: '08:40' },
      { period: 2, start: '08:55', end: '09:35' },
    ],
    schedule: {
      source: 'fast_constructed',
      slots: [{ id: 'slot_1', classId: 'c1', subjectId: 'math', teacherId: 't_math', day: 1, period: 1 }],
    },
  });

  const panel = renderSchedulePanel(state);

  assert.match(panel, /第1节/);
  assert.match(panel, /08:00-08:40/);
  assert.match(panel, /第2节/);
  assert.match(panel, /08:55-09:35/);
});

test('timetable schedule grid labels formal rows by configured time segment', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const state = sampleWorkbenchState();
  state.project = createDefaultTimetableProject({
    activeWeekdays: [1, 2],
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    periodTimeSegments: {
      globalDefaults: { classMinutes: 40, breakMinutes: 10 },
      segments: [
        { id: 'early-study', label: '早读', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
        { id: 'evening-study', label: '晚自习', startTime: '19:00', periodCount: 2, classMinutes: 45, breakMinutes: 10, kind: 'duty' },
        { id: 'morning', label: '上午', startTime: '08:00', periodCount: 2, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
        { id: 'afternoon', label: '下午', startTime: '14:00', periodCount: 1, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
        { id: 'campus-display', label: '离校提醒', startTime: '20:50', periodCount: 1, classMinutes: 20, breakMinutes: 0, kind: 'display' },
      ],
    },
    periodTimes: [
      { period: 1, start: '08:00', end: '08:40' },
      { period: 2, start: '08:50', end: '09:30' },
      { period: 3, start: '14:00', end: '14:40' },
    ],
    schedule: {
      source: 'fast_constructed',
      slots: [{ id: 'slot_1', classId: 'c1', subjectId: 'math', teacherId: 't_math', day: 1, period: 2 }],
    },
  });

  const panel = renderSchedulePanel(state);
  const earlyIndex = panel.indexOf('data-time-block-id="early-study"');
  const morningIndex = panel.indexOf('data-period-segment-id="morning"');
  const afternoonIndex = panel.indexOf('data-period-segment-id="afternoon"');
  const eveningIndex = panel.indexOf('data-time-block-id="evening-study__p1"');

  assert.match(panel, /data-time-block-id="early-study"[\s\S]*早读[\s\S]*07:20-07:50[\s\S]*值班/);
  assert.doesNotMatch(panel, /data-time-block-id="early-study"[\s\S]{0,180}第1节/);
  assert.match(panel, /data-period-segment-id="morning"[\s\S]*tt-period-segment-chip[\s\S]*上午[\s\S]*第1节[\s\S]*08:00-08:40/);
  assert.match(panel, /data-period-segment-id="afternoon"[\s\S]*tt-period-segment-chip[\s\S]*下午[\s\S]*第3节[\s\S]*14:00-14:40/);
  assert.ok(earlyIndex >= 0, 'early study row should be rendered');
  assert.ok(morningIndex > earlyIndex, 'morning formal periods should follow early study by time');
  assert.ok(afternoonIndex > morningIndex, 'afternoon formal periods should follow morning periods by time');
  assert.ok(eveningIndex > afternoonIndex, 'evening study rows should follow formal daytime periods by time');
  assert.match(panel, /tt-study-period--duty" data-time-block-id="evening-study__p1"[\s\S]*晚自习1[\s\S]*19:00-19:45[\s\S]*值班/);
  assert.match(panel, /tt-study-period--duty" data-time-block-id="evening-study__p2"[\s\S]*晚自习2[\s\S]*19:55-20:40[\s\S]*值班/);
  assert.match(panel, /tt-duty-cell[\s\S]*data-time-block-id="evening-study__p2"/);
  assert.match(panel, /未排值班/);
  assert.doesNotMatch(panel, /未安排值班/);
  assert.doesNotMatch(panel, /tt-study-period--separated/);
  assert.doesNotMatch(panel, /tt-study-cell--separated/);
  assert.doesNotMatch(panel, /data-period-segment-id="evening-study"[\s\S]*第4节/);
  assert.match(panel, /data-time-block-id="campus-display"[\s\S]*离校提醒[\s\S]*20:50-21:10/);
  assert.doesNotMatch(panel, /data-period-segment-id="campus-display"[\s\S]*第4节/);
  assert.doesNotMatch(panel, /非正式时段|仅展示/);
  assert.match(styles, /\.tt-period-segment-chip\s*{/);
  assert.match(styles, /\.tt-period--segment-start\s*{/);
  assert.doesNotMatch(styles, /\.tt-study-period\s*{[^}]*border-style:\s*dashed/s);
  assert.match(styles, /\.tt-study-period\s*{[^}]*background:\s*var\(--tt-bg-soft\)/s);
  assert.doesNotMatch(styles, /\.tt-study-period\s*{[^}]*color-mix\(in srgb,\s*var\(--tt-bg-input\)/s);
  assert.match(styles, /\.tt-study-period strong\s*{[^}]*color:\s*var\(--tt-text-secondary\)[^}]*font-size:\s*0\.76rem/s);
  assert.match(styles, /\.tt-study-period em\s*{[^}]*color:\s*var\(--tt-muted\)[^}]*font-weight:\s*700/s);
  assert.doesNotMatch(styles, /\.tt-study-period em\s*{[^}]*color:\s*var\(--tt-accent-strong\)/s);
  assert.match(styles, /\.tt-study-cell\s*{[^}]*border:\s*0/s);
  assert.match(styles, /\.tt-study-cell\s*{[^}]*background:\s*var\(--tt-bg-base\)/s);
  assert.match(styles, /button\.tt-duty-cell:hover,\s*button\.tt-duty-cell:focus-visible\s*{[^}]*background:\s*var\(--tt-bg-base\)/s);
  assert.match(styles, /\.tt-duty-cell\.is-missing span\s*{[^}]*min-height:\s*22px/s);
  assert.match(styles, /\.tt-duty-cell\.is-missing span\s*{[^}]*padding:\s*0 7px/s);
  assert.match(styles, /\.tt-duty-cell\.is-missing span\s*{[^}]*font-size:\s*0\.72rem/s);
  assert.match(styles, /\.tt-duty-cell\.is-missing span\s*{[^}]*border:\s*1px\s+dashed\s+var\(--tt-border-strong\)/s);
  assert.match(styles, /\.tt-study-cell\s*{[^}]*justify-items:\s*center/s);
});

test('timetable manual adjustment success clears stale solve failure state', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');

  assert.match(controllerSource, /async adjustSlot\([\s\S]*this\.state\.lastFailure = null;/);
});

test('timetable optimization polling success clears stale solve failure state', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');

  assert.match(controllerSource, /async refreshOptimizationJob\([\s\S]*status === 'completed' && result\.job\.accepted[\s\S]*this\.state\.lastFailure = null;/);
  assert.match(controllerSource, /async refreshOptimizationJob\([\s\S]*else if \(result\.job\.status === 'completed'\)[\s\S]*this\.state\.lastFailure = null;/);
  assert.match(controllerSource, /async refreshOptimizationJob\([\s\S]*else if \(result\.job\.status === 'failed'\)[\s\S]*this\.state\.lastFailure = null;/);
});

test('timetable optimization polling ignores stale job responses after manual state changes', async () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.solverJob = { jobId: 'job-old', status: 'running' };
  controller.state.message = '手动调整中';
  let resolveJobResponse;
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(String(url));
    await new Promise(resolve => {
      resolveJobResponse = resolve;
    });
    return {
      ok: true,
      async json() {
        return {
          success: true,
          data: {
            job: { jobId: 'job-old', status: 'completed', accepted: false, reason: 'not_better' },
          },
        };
      },
    };
  };

  try {
    const refreshPromise = controller.refreshOptimizationJob('job-old');
    await Promise.resolve();
    controller.state.solverJob = null;
    controller.state.message = '已调整。';
    resolveJobResponse();
    await refreshPromise;

    assert.deepEqual(requests, ['/api/tools/timetable/schedule/jobs/job-old']);
    assert.equal(controller.state.solverJob, null);
    assert.equal(controller.state.message, '已调整。');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable optimization polling still applies current job responses', async () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.startOptimizationPolling = job => {
    controller._nextPolledJob = job;
  };
  controller.state.solverJob = { jobId: 'job-current', status: 'running' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => ({
    ok: true,
    async json() {
      assert.equal(String(url), '/api/tools/timetable/schedule/jobs/job-current');
      return {
        success: true,
        data: {
          job: { jobId: 'job-current', status: 'completed', accepted: false, reason: 'not_better' },
        },
      };
    },
  });

  try {
    await controller.refreshOptimizationJob('job-current');

    assert.deepEqual(controller.state.solverJob, {
      jobId: 'job-current',
      status: 'completed',
      accepted: false,
      reason: 'not_better',
    });
    assert.match(controller.state.message, /快速|课表|保留|蹇/);
    assert.equal(controller.state.lastFailure, null);
    assert.equal(controller._nextPolledJob.jobId, 'job-current');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable optimization polling explains skipped stale jobs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.match(String(url), /\/schedule\/jobs\/job_skip$/);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          data: {
            job: { jobId: 'job_skip', status: 'skipped', accepted: false, reason: 'stale_schedule' },
          },
        };
      },
    };
  };
  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.applyProject(createDefaultTimetableProject({
      schedule: {
        id: 'schedule_1',
        source: 'fast_constructed',
        slots: [{ id: 'slot_1', classId: 'c1', subjectId: 'math', teacherId: 't_math', day: 1, period: 1 }],
      },
    }));
    controller.state.solverJob = { jobId: 'job_skip', status: 'running' };

    await controller.refreshOptimizationJob('job_skip');

    assert.equal(controller.state.message, '课表已变化，已丢弃旧优化结果。');
    assert.equal(controller.state.lastFailure, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable publish success clears stale solve failure state', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');

  assert.match(controllerSource, /async confirmPublishSchedule\([\s\S]*this\.state\.lastFailure = null;/);
});

test('timetable 智能 rule acceptance reuses saved rules response instead of extra bootstrap refresh', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');

  assert.match(controllerSource, /async acceptRule\([\s\S]*const result = await requestTimetable\('\/rules'/);
  assert.match(controllerSource, /async acceptRule\([\s\S]*this\.applyProject\(result\.project\);/);
  assert.doesNotMatch(controllerSource, /async acceptRule\([\s\S]*await this\.refreshProject\(\);/);

  assert.match(controllerSource, /async acceptAllRules\([\s\S]*const result = await requestTimetable\('\/rules'/);
  assert.match(controllerSource, /async acceptAllRules\([\s\S]*this\.applyProject\(result\.project\);/);
  assert.doesNotMatch(controllerSource, /async acceptAllRules\([\s\S]*await this\.refreshProject\(\);/);
});

test('timetable legacy bulk 智能 rule acceptance keeps review-only drafts pending', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/rules/normalize')) {
      assert.deepEqual(body.draftRows.map(row => row.id), ['auto-1']);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              draftRows: [{ id: 'auto-1', status: 'effective' }],
              draftRules: { hardRules: { teacherUnavailable: { t1: ['3-5'] } }, softRules: {} },
            },
          };
        },
      };
    }
    if (String(url).endsWith('/rules')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              project: createDefaultTimetableProject({
                rules: body.rules,
              }),
            },
          };
        },
      };
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.state.project = createDefaultTimetableProject();
    controller.state.ruleReview = {
      conflicts: [{ level: 'blocking', relatedRuleIds: ['conflict-1'] }],
    };
    controller.state.pendingRules = [{
      id: 'auto-1',
      type: 'teacher_unavailable',
      targetType: 'teacher',
      targetId: 't1',
      targetName: 'Teacher 1',
      slots: ['3-5'],
      priority: 'hard',
      status: 'effective',
      confidence: 0.91,
      warnings: [],
    }, {
      id: 'conflict-1',
      type: 'teacher_unavailable',
      targetType: 'teacher',
      targetId: 't2',
      targetName: 'Teacher 2',
      slots: ['3-5'],
      priority: 'hard',
      status: 'effective',
      confidence: 0.95,
      warnings: [],
    }, {
      id: 'review-1',
      type: 'teacher_unavailable',
      targetType: 'teacher',
      targetName: 'Teacher',
      slots: ['3-5'],
      priority: 'hard',
      status: 'needs_review',
      confidence: 0.7,
      warnings: ['存在多个候选教师'],
    }, {
      id: 'unsupported-1',
      type: 'teacher_free_period_compact',
      targetType: 'global',
      status: 'unsupported',
      confidence: 0.9,
      warnings: [],
    }];

    await controller.acceptAllRules();

    assert.ok(calls.some(call => call.url.endsWith('/rules/normalize')));
    assert.ok(calls.some(call => call.url.endsWith('/rules')));
    assert.deepEqual(controller.state.pendingRules.map(row => row.id), ['conflict-1', 'review-1', 'unsupported-1']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable auto-apply only sends safe high-confidence review rows', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/rules/normalize')) {
      assert.deepEqual(body.draftRows.map(row => row.id), ['safe-1']);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              draftRows: [{ id: 'safe-1', status: 'effective' }],
              draftRules: { hardRules: { teacherUnavailable: { t1: ['3-5'] } }, softRules: {} },
              autoAcceptable: [{ id: 'safe-1', status: 'effective' }],
              needReview: [],
              warnings: [],
              unsupportedItems: [],
              conflicts: [],
            },
          };
        },
      };
    }
    if (String(url).endsWith('/rules')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              project: createDefaultTimetableProject({
                rules: body.rules,
              }),
            },
          };
        },
      };
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.state.project = createDefaultTimetableProject();
    controller.state.ruleReview = {
      open: true,
      step: 'review',
      mode: 'text',
      text: 'dialog text',
      originalText: 'original constraint',
      draftRows: [
        { id: 'safe-1', status: 'effective', type: 'teacher_unavailable', confidence: 0.91, warnings: [] },
        { id: 'review-1', status: 'needs_review', type: 'teacher_unavailable', confidence: 0.91, warnings: [] },
        { id: 'low-1', status: 'effective', type: 'teacher_unavailable', confidence: 0.7, warnings: [] },
        { id: 'suggestion-1', status: 'suggestion', type: 'teacher_load_balance', confidence: 0.95, warnings: [] },
      ],
      autoAcceptable: [
        { id: 'safe-1', status: 'effective', type: 'teacher_unavailable', confidence: 0.91, warnings: [] },
        { id: 'review-1', status: 'needs_review', type: 'teacher_unavailable', confidence: 0.91, warnings: [] },
        { id: 'low-1', status: 'effective', type: 'teacher_unavailable', confidence: 0.7, warnings: [] },
        { id: 'suggestion-1', status: 'suggestion', type: 'teacher_load_balance', confidence: 0.95, warnings: [] },
      ],
      needReview: [],
      warnings: [],
      unsupportedItems: [],
      conflicts: [],
    };

    await controller.applyAutoAcceptableRules();

    assert.ok(calls.some(call => call.url.endsWith('/rules/normalize')));
    assert.ok(calls.some(call => call.url.endsWith('/rules')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable successful data and rule mutations clear stale solve failure state', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const mutatingMethods = [
    'saveProject',
    'importRoster',
    'clearRoster',
    'saveRules',
    'acceptAllRules',
    'confirmRuleDraft',
    'removeSavedRule',
    'clearRules',
    'addLockedSlot',
    'removeLockedSlot',
    'confirmRestoreSchedule',
  ];

  for (const methodName of mutatingMethods) {
    const methodSource = extractMethodSource(controllerSource, methodName);
    assert.match(methodSource, /this\.state\.lastFailure\s*=\s*null;/);
  }
});

test('timetable mutations that invalidate the current draft clear selected slot state', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const selectionResetMethods = [
    'saveProject',
    'importRoster',
    'clearRoster',
    'saveRules',
    'confirmRuleDraft',
    'removeSavedRule',
    'clearRules',
    'addLockedSlot',
    'removeLockedSlot',
    'confirmRestoreSchedule',
  ];

  for (const methodName of selectionResetMethods) {
    const methodSource = extractMethodSource(controllerSource, methodName);
    assert.match(methodSource, /this\.state\.selectedSlotId\s*=\s*'';/);
  }
});

test('timetable clearRuleDraft clears pending 智能 rule cards and expanded editor state', () => {
  const controller = new TimetablePlannerController();
  controller.state.pendingRules = [{ id: 'draft-1' }];
  controller.state.expandedRuleId = 'draft-1';
  controller.state.ruleDraft = { hardRules: {}, softRules: {} };
  controller.state.ruleDraftPreview = [{ id: 'preview-1' }];
  controller.state.ruleWarnings = [{ message: 'warn' }];
  controller.state.ruleReview = {
    ...controller.state.ruleReview,
    open: true,
    draftRows: [{ id: 'draft-1' }],
  };

  controller.clearRuleDraft();

  assert.deepEqual(controller.state.pendingRules, []);
  assert.equal(controller.state.expandedRuleId, null);
  assert.equal(controller.state.ruleDraft, null);
  assert.deepEqual(controller.state.ruleDraftPreview, []);
  assert.deepEqual(controller.state.ruleWarnings, []);
  assert.equal(controller.state.ruleReview.open, false);
  assert.deepEqual(controller.state.ruleReview.draftRows, []);
});

test('timetable applyProject clears stale selected and drag slot state when the schedule changes', () => {
  const controller = new TimetablePlannerController();
  controller.state.selectedSlotId = 'slot-old';
  controller.state.dragSlotId = 'slot-old';
  controller.state.dragBlockId = 'block-old';
  controller.state.viewMode = 'class';
  controller.state.selectedOwnerId = 'c1';

  controller.applyProject(createDefaultTimetableProject({
    teachers: [{ id: 't1', name: 'Teacher 1', subjects: ['s1'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 's1', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyHours: 3 }],
    schedule: {
      id: 'schedule-new',
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{
        id: 'slot-new',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 's1',
        teacherId: 't1',
        teacherIds: ['t1'],
        lessonPlanId: 'lp1',
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
  }));

  assert.equal(controller.state.selectedSlotId, '');
  assert.equal(controller.state.dragSlotId, '');
  assert.equal(controller.state.dragBlockId, '');
});

test('timetable applyProject preserves active selected and drag slot state when the slot still exists', () => {
  const controller = new TimetablePlannerController();
  controller.state.selectedSlotId = 'slot-1';
  controller.state.dragSlotId = 'slot-1';
  controller.state.dragBlockId = 'block-1';
  controller.state.viewMode = 'class';
  controller.state.selectedOwnerId = 'c1';

  controller.applyProject(createDefaultTimetableProject({
    teachers: [{ id: 't1', name: 'Teacher 1', subjects: ['s1'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 's1', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyHours: 3 }],
    schedule: {
      id: 'schedule-current',
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 's1',
        teacherId: 't1',
        teacherIds: ['t1'],
        lessonPlanId: 'lp1',
        blockId: 'block-1',
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
  }));

  assert.equal(controller.state.selectedSlotId, 'slot-1');
  assert.equal(controller.state.dragSlotId, 'slot-1');
  assert.equal(controller.state.dragBlockId, 'block-1');
});

test('timetable applyProject clears selected and drag slot state when the slot is no longer visible in the current view', () => {
  const controller = new TimetablePlannerController();
  controller.state.selectedSlotId = 'slot-1';
  controller.state.dragSlotId = 'slot-1';
  controller.state.dragBlockId = 'block-1';
  controller.state.viewMode = 'teacher';
  controller.state.selectedOwnerId = 't1';

  controller.applyProject(createDefaultTimetableProject({
    teachers: [
      { id: 't1', name: 'Teacher 1', subjects: ['s1'], unavailableSlots: [] },
      { id: 't2', name: 'Teacher 2', subjects: ['s1'], unavailableSlots: [] },
    ],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 's1', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp1', classId: 'c1', subjectId: 's1', teacherId: 't2', weeklyHours: 3 }],
    schedule: {
      id: 'schedule-current',
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 's1',
        teacherId: 't2',
        teacherIds: ['t2'],
        lessonPlanId: 'lp1',
        blockId: 'block-1',
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
  }));

  assert.equal(controller.state.selectedOwnerId, 't1');
  assert.equal(controller.state.selectedSlotId, '');
  assert.equal(controller.state.dragSlotId, '');
  assert.equal(controller.state.dragBlockId, '');
});

test('timetable applyProject closes stale publication history and restore dialogs when their target version disappears', () => {
  const controller = new TimetablePlannerController();
  controller.state.publicationHistoryDialog = { open: true, version: 1 };
  controller.state.restoreDialog = {
    open: true,
    mode: 'history',
    version: 1,
    targetLabel: 'Publication history V1',
    summary: { total: 1 },
    loading: false,
  };

  controller.applyProject(createDefaultTimetableProject({
    schedule: {
      id: 'published-current',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 0, totalLessons: 0, completeness: 100 },
      published: {
        status: 'published',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-current',
        snapshot: { scheduleId: 'published-current', slotCount: 0, slots: [] },
        history: [],
      },
    },
  }));

  assert.deepEqual(controller.state.publicationHistoryDialog, { open: false, version: null });
  assert.deepEqual(controller.state.restoreDialog, {
    open: false,
    mode: '',
    version: null,
    targetLabel: '',
    summary: null,
    loading: false,
  });
});

test('timetable applyProject preserves publication dialogs when their target version still exists', () => {
  const controller = new TimetablePlannerController();
  controller.state.publicationHistoryDialog = { open: true, version: '1' };
  controller.state.restoreDialog = {
    open: true,
    mode: 'history',
    version: '1',
    targetLabel: 'Publication history V1',
    summary: { total: 1 },
    loading: false,
  };

  controller.applyProject(createDefaultTimetableProject({
    schedule: {
      id: 'published-current',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 0, totalLessons: 0, completeness: 100 },
      published: {
        status: 'published',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-current',
        snapshot: { scheduleId: 'published-current', slotCount: 0, slots: [] },
        history: [{
          version: 1,
          publishedAt: '2026-01-01T08:00:00.000Z',
          scheduleId: 'published-v1',
          snapshot: { scheduleId: 'published-v1', slotCount: 0, slots: [] },
        }],
      },
    },
  }));

  assert.deepEqual(controller.state.publicationHistoryDialog, { open: true, version: 1 });
  assert.deepEqual(controller.state.restoreDialog, {
    open: true,
    mode: 'history',
    version: 1,
    targetLabel: 'Publication history V1',
    summary: { total: 1 },
    loading: false,
  });
});

test('timetable applyProject closes an open publish dialog when the new schedule is not ready', () => {
  const controller = new TimetablePlannerController();
  controller.state.publishDialog = { open: true, note: 'ready before mutation', loading: false };

  controller.applyProject(createDefaultTimetableProject({
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    schedule: {
      id: 'blocked-after-mutation',
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [{ lessonPlanId: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      publication: {
        ok: false,
        reason: 'publication_blocked',
        blockingIssues: [{ type: 'incomplete_schedule', message: 'unplaced lesson' }],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 1, placedLessons: 0, unplacedLessons: 1, hardConflicts: 0 },
      },
      score: { hardConflicts: 0, unplacedLessons: 1, placedLessons: 0, totalLessons: 1, completeness: 0 },
    },
  }));

  assert.deepEqual(controller.state.publishDialog, { open: false, note: '', loading: false });
});

test('timetable restore dialog refuses missing publication history versions before confirmation', () => {
  const controller = new TimetablePlannerController();
  controller.state.project = createDefaultTimetableProject({
    schedule: {
      id: 'published-current',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 0, totalLessons: 0, completeness: 100 },
      published: {
        status: 'published',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-current',
        snapshot: { scheduleId: 'published-current', slotCount: 0, slots: [] },
        history: [],
      },
    },
  });

  controller.openRestoreDialog('history', 1);

  assert.deepEqual(controller.state.restoreDialog, {
    open: false,
    mode: '',
    version: null,
    targetLabel: '',
    summary: null,
    loading: false,
  });
  assert.match(controller.state.message, /1/);
});

test('timetable latest restore dialog still opens for legacy published projects without a saved snapshot', () => {
  const controller = new TimetablePlannerController();
  controller.state.project = createDefaultTimetableProject({
    schedule: {
      id: 'legacy-published',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 0, totalLessons: 0, completeness: 100 },
      published: {
        status: 'published',
        version: 3,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'legacy-published',
        note: 'legacy published without snapshot',
      },
    },
  });

  controller.openRestoreDialog('latest', 3);

  assert.equal(controller.state.restoreDialog.open, true);
  assert.equal(controller.state.restoreDialog.mode, 'latest');
  assert.equal(controller.state.restoreDialog.version, 3);
  assert.match(controller.state.restoreDialog.targetLabel, /3/);
});

test('timetable publication history dialog refuses missing history versions before rendering', () => {
  const controller = new TimetablePlannerController();
  controller.state.project = createDefaultTimetableProject({
    schedule: {
      id: 'published-current',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 0, totalLessons: 0, completeness: 100 },
      published: {
        status: 'published',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-current',
        snapshot: { scheduleId: 'published-current', slotCount: 0, slots: [] },
        history: [],
      },
    },
  });

  controller.openPublicationHistoryDialog(1);

  assert.deepEqual(controller.state.publicationHistoryDialog, { open: false, version: null });
  assert.match(controller.state.message, /1/);
});

test('timetable syncPendingRuleDraftState keeps 智能 draft review state aligned', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.project = createDefaultTimetableProject({
    teachers: [{ id: 't1', name: 'Teacher 1', subjects: ['s1'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 's1', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyHours: 3 }],
  });
  controller.state.ruleReview = {
    ...controller.state.ruleReview,
    open: true,
    step: 'review',
    mode: 'file',
    inputType: 'xlsx_constraints',
    contextStats: { rowCount: 2 },
    warnings: ['warn-1'],
    unsupportedItems: [{ id: 'u1', type: 'suggestion' }],
  };
  controller.state.ruleWarnings = ['warn-1'];
  controller.state.ruleUnsupportedItems = [{ id: 'u1', type: 'suggestion' }];
  controller.state.expandedRuleId = 'draft-2';
  controller.state.ruleDraft = { hardRules: { teacherUnavailable: { t1: ['1-1'] } }, softRules: {} };

  controller.syncPendingRuleDraftState([
    { id: 'draft-1', type: 'teacher_unavailable', targetName: 'Teacher 1', status: 'effective', slots: ['1-1'] },
    { id: 'draft-2', type: 'class_unavailable', targetName: 'G7 1', status: 'needs_review', slots: ['2-2'] },
  ]);

  assert.deepEqual(controller.state.pendingRules.map(item => item.id), ['draft-1', 'draft-2']);
  assert.equal(controller.state.expandedRuleId, 'draft-2');
  assert.equal(controller.state.ruleDraft, null);
  assert.equal(controller.state.ruleReview.open, true);
  assert.equal(controller.state.ruleReview.step, 'review');
  assert.equal(controller.state.ruleReview.inputType, 'xlsx_constraints');
  assert.deepEqual(controller.state.ruleReview.warnings, ['warn-1']);
  assert.equal(controller.state.ruleDraftPreview.length, 2);

  controller.syncPendingRuleDraftState([], { keepDialogOpen: true });

  assert.deepEqual(controller.state.pendingRules, []);
  assert.equal(controller.state.expandedRuleId, null);
  assert.equal(controller.state.ruleDraft, null);
  assert.deepEqual(controller.state.ruleWarnings, []);
  assert.deepEqual(controller.state.ruleUnsupportedItems, []);
  assert.equal(controller.state.ruleReview.open, true);
  assert.equal(controller.state.ruleReview.step, 'input');
});

test('timetable syncPendingRuleDraftState drops stale unsupported 智能 items when draft rows shrink', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.project = createDefaultTimetableProject();
  controller.state.ruleReview = {
    ...controller.state.ruleReview,
    open: true,
    step: 'review',
    mode: 'file',
    inputType: 'xlsx_constraints',
    unsupportedItems: [
      { id: 'draft-suggestion', type: 'teacher_load_balance', description: 'keep me if still present' },
      { id: 'draft-removed', type: 'spread_hint', description: 'should disappear with removed row' },
    ],
  };
  controller.state.ruleUnsupportedItems = [
    { id: 'draft-suggestion', type: 'teacher_load_balance', description: 'keep me if still present' },
    { id: 'draft-removed', type: 'spread_hint', description: 'should disappear with removed row' },
  ];

  controller.syncPendingRuleDraftState([
    {
      id: 'draft-suggestion',
      type: 'teacher_load_balance',
      targetName: 'All teachers',
      status: 'suggestion',
      slots: [],
      description: 'keep me if still present',
    },
    {
      id: 'draft-effective',
      type: 'teacher_unavailable',
      targetName: 'Teacher 1',
      status: 'effective',
      slots: ['1-1'],
    },
  ]);

  assert.deepEqual(
    controller.state.ruleUnsupportedItems.map(item => item.id),
    ['draft-suggestion'],
  );
  assert.deepEqual(
    controller.state.ruleReview.unsupportedItems.map(item => item.id),
    ['draft-suggestion'],
  );
});

test('timetable inspector renders scheduling audit and quality suggestions', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: { teacherLimits: { t_math: { consecutive: 2 } } } },
      schedule: {
        id: 'audit-schedule',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        audit: {
          blockingIssues: [],
          warnings: [{ type: 'teacher_load', message: 'Math Teacher load is high' }],
          bottlenecks: { teachers: [{ id: 't_math', name: 'Math Teacher', utilization: 86 }] },
          capacity: { totalLessons: 3, availableSlots: 35 },
        },
        qualityIssues: [
          { type: 'teacher_consecutive', severity: 'warning', teacherId: 't_math', message: 'Math Teacher has too many consecutive lessons' },
        ],
        score: {
          hardConflicts: 0,
          unplacedLessons: 0,
          placedLessons: 3,
          totalLessons: 3,
          completeness: 100,
          softSatisfaction: 74,
          softBreakdown: { teacherConsecutive: 60, classDailyBalance: 75 },
        },
      },
    }),
  });

  const inspector = renderInspector(state);
  const systemMarkup = inspectorSystemMarkup(inspector);

  assert.match(inspector, /Math Teacher load is high/);
  assert.match(inspector, /教师负载/);
  assert.match(inspector, /Math Teacher has too many consecutive lessons/);
  assert.match(inspector, /教师连续课/);
  assert.match(inspector, /tt-inspector-problem-group is-warning/);
  assert.match(inspector, /tt-inspector-target-row/);
  assert.match(systemMarkup, /数据摘要/);
  assert.match(systemMarkup, /生成详情/);
  assert.doesNotMatch(systemMarkup, /排课诊断/);
  assert.doesNotMatch(systemMarkup, /诊断问题/);
  assert.doesNotMatch(systemMarkup, /质量建议/);
  assert.doesNotMatch(systemMarkup, /班级日负载/);
  assert.doesNotMatch(inspector, /teacher_load/);
  assert.doesNotMatch(inspector, /teacherConsecutive/);
  assert.doesNotMatch(inspector, /classDailyBalance/);
});

test('timetable inspector view model summarizes not-generated schedules', () => {
  const model = buildInspectorViewModel(sampleWorkbenchState({ schedule: null }));

  assert.equal(model.verdict.status, 'not_generated');
  assert.equal(model.verdict.title, '未生成');
  assert.equal(model.verdict.tone, 'warn');
  assert.equal(model.metrics.placed, 0);
  assert.equal(model.metrics.total, 3);
  assert.equal(model.metrics.hardConflicts, 0);
  assert.equal(model.metrics.unplaced, 3);
  assert.deepEqual(model.blockingItems, []);
  assert.deepEqual(model.reviewItems, []);
  assert.ok(model.systemDetails.some(item => item.group === 'data'));
});

test('timetable inspector view model separates blocking issues from review suggestions', () => {
  const state = sampleWorkbenchState({
    schedule: {
      id: 'schedule-review-model',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      lockedSlots: [],
      unplaced: [{ lessonPlanId: 'lp_math', reason: 'No slot' }],
      conflicts: [
        { id: 'conflict-teacher', severity: 'hard', type: 'teacher_conflict', message: 'Math Teacher 同时上课。' },
      ],
      qualityIssues: [
        { id: 'quality-manual', severity: 'warning', type: 'manual_review', message: '请教务复核排课质量。', slot: { day: 2, period: 3 } },
      ],
      diagnostics: {
        items: [
          {
            id: 'publication-blocker',
            category: 'publication',
            severity: 'error',
            type: 'incomplete_schedule',
            targetName: 'G7 1',
            message: 'G7 1 还有 1 节未排。',
          },
          {
            id: 'diagnostic-warning',
            category: 'schedule',
            severity: 'warning',
            type: 'teacher_load',
            targetName: 'Math Teacher',
            message: 'Math Teacher 负载接近满载。',
          },
        ],
        suggestions: [
          { id: 'suggestion-1', message: '建议复核教师负载。' },
        ],
      },
      score: {
        hardConflicts: 1,
        unplacedLessons: 1,
        placedLessons: 1,
        totalLessons: 2,
        completeness: 50,
      },
      solverStats: {
        phase: 'timefold_optimization',
        status: 'completed',
        accepted: false,
        reason: 'not_better',
      },
    },
  });

  const model = buildInspectorViewModel(state);

  assert.equal(model.verdict.status, 'blocked');
  assert.equal(model.verdict.title, '不可发布');
  assert.equal(model.verdict.tone, 'danger');
  assert.equal(model.metrics.placed, 1);
  assert.equal(model.metrics.total, 2);
  assert.equal(model.metrics.hardConflicts, 1);
  assert.equal(model.metrics.unplaced, 1);
  assert.equal(model.metrics.warnings, 2);
  assert.match(model.verdict.message, /必须处理/);
  assert.ok(model.blockingItems.some(item => item.message.includes('同时上课')));
  assert.ok(model.blockingItems.some(item => item.message.includes('未排')));
  assert.ok(model.blockingItems.some(item => item.title.includes('G7 1')));
  assert.ok(model.reviewItems.some(item => item.message.includes('教务复核排课质量')));
  assert.ok(model.reviewItems.some(item => item.message.includes('负载接近满载')));
  assert.equal(model.reviewItems.some(item => item.message.includes('建议复核教师负载')), false);
  assert.ok(model.systemDetails.some(item => item.group === 'solver'));
});

test('timetable inspector view model reports publishable schedules as a clear verdict', () => {
  const state = sampleWorkbenchState({
    schedule: {
      id: 'schedule-ok',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [
        { id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
        { id: 'slot-2', day: 2, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
        { id: 'slot-3', day: 3, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
      ],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues: [],
      diagnostics: { items: [], suggestions: [] },
      score: {
        hardConflicts: 0,
        unplacedLessons: 0,
        placedLessons: 3,
        totalLessons: 3,
        completeness: 100,
      },
      publication: {
        ok: true,
        summary: {
          placedLessons: 3,
          totalLessons: 3,
          hardConflicts: 0,
          unplacedLessons: 0,
        },
        reviewItems: [],
      },
      solverStats: { phase: 'fast_scheduler', status: 'completed' },
    },
  });

  const model = buildInspectorViewModel(state);

  assert.equal(model.verdict.status, 'publishable');
  assert.equal(model.verdict.title, '可发布');
  assert.equal(model.verdict.tone, 'ok');
  assert.equal(model.metrics.placed, 3);
  assert.equal(model.metrics.total, 3);
  assert.equal(model.metrics.warnings, 0);
  assert.deepEqual(model.blockingItems, []);
  assert.deepEqual(model.reviewItems, []);
  assert.ok(model.systemDetails.some(item => item.group === 'data'));
  assert.ok(model.systemDetails.some(item => item.group === 'solver'));
});

test('timetable inspector renders grouped review workbench sections', () => {
  const state = sampleWorkbenchState({
    schedule: {
      id: 'schedule-review-panel',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      lockedSlots: [],
      unplaced: [{ lessonPlanId: 'lp_math', reason: 'No slot' }],
      conflicts: [
        { id: 'conflict-teacher', severity: 'hard', type: 'teacher_conflict', message: 'Math Teacher 同时上课。' },
      ],
      qualityIssues: [
        { id: 'quality-manual', severity: 'warning', type: 'manual_review', message: '请教务复核排课质量。', slot: { day: 2, period: 3 } },
      ],
      diagnostics: {
        items: [
          {
            id: 'diagnostic-warning',
            category: 'schedule',
            severity: 'warning',
            type: 'teacher_load',
            targetName: 'Math Teacher',
            message: 'Math Teacher 负载接近满载。',
          },
        ],
        suggestions: [{ id: 'suggestion-1', message: '建议复核教师负载。' }],
      },
      score: {
        hardConflicts: 1,
        unplacedLessons: 1,
        placedLessons: 1,
        totalLessons: 2,
        completeness: 50,
      },
    },
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /当前结论/);
  assert.match(inspector, /不可发布/);
  assert.match(inspector, /已排\s*1\/2/);
  assert.match(inspector, /硬冲突\s*1/);
  assert.match(inspector, /未排\s*1/);
  assert.match(inspector, /必须处理/);
  assert.match(inspector, /Math Teacher 同时上课。/);
  assert.match(inspector, /建议复核/);
  assert.match(inspector, /请教务复核排课质量。/);
  assert.match(inspector, /课节 2-3/);
  assert.doesNotMatch(inspector, /\[object Object\]/);
  assert.match(inspector, /系统详情/);
  assert.doesNotMatch(inspector, /<span>诊断报告<\/span>/);
  assert.doesNotMatch(inspector, /<span>排课诊断<\/span>/);
  assert.doesNotMatch(inspector, /<span>质量建议<\/span>/);
  assert.doesNotMatch(inspector, /<span>冲突<\/span>/);
});

test('timetable inspector renders clickable progressive controls for truncated issue groups', () => {
  const qualityIssues = Array.from({ length: 12 }, (_, index) => ({
    id: `quality-${index + 1}`,
    severity: 'warning',
    type: 'manual_review',
    message: `质量建议 ${index + 1}`,
  }));
  const state = sampleWorkbenchState({
    schedule: {
      id: 'schedule-review-expand-controls',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues,
      diagnostics: { items: [], suggestions: [] },
      score: {
        hardConflicts: 0,
        unplacedLessons: 0,
        placedLessons: 3,
        totalLessons: 3,
        completeness: 100,
      },
    },
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /质量建议 5/);
  assert.doesNotMatch(inspector, /质量建议 6/);
  assert.match(inspector, /已显示\s*5\/12/);
  assert.match(inspector, /展开剩余\s*7/);
  assert.match(inspector, /data-action="expand-inspector-issue-group"/);
  assert.match(inspector, /data-inspector-issue-limit-key="review:group-[^"]+"/);
  assert.doesNotMatch(inspector, /data-inspector-issue-limit-key="review:quality"/);
  assert.doesNotMatch(inspector, /还有\s*7\s*项未展开/);
});

test('timetable inspector applies independent expanded limits per issue group', () => {
  const qualityIssues = Array.from({ length: 8 }, (_, index) => ({
    id: `quality-${index + 1}`,
    severity: 'warning',
    type: 'manual_review',
    message: `质量建议 ${index + 1}`,
  }));
  const teacherLoadIssues = Array.from({ length: 8 }, (_, index) => ({
    id: `teacher-load-${index + 1}`,
    severity: 'warning',
    type: 'teacher_load',
    teacherId: 't_math',
    message: `教师负载建议 ${index + 1}`,
  }));
  const baseState = {
    schedule: {
      id: 'schedule-review-expanded-limits',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues: [...qualityIssues, ...teacherLoadIssues],
      diagnostics: { items: [], suggestions: [] },
      score: {
        hardConflicts: 0,
        unplacedLessons: 0,
        placedLessons: 3,
        totalLessons: 3,
        completeness: 100,
      },
    },
  };

  const collapsedInspector = renderInspector(sampleWorkbenchState(baseState));
  const qualityLimitKey = collapsedInspector.match(/<strong>教务复核<\/strong>[\s\S]*?data-inspector-issue-limit-key="([^"]+)"/)?.[1] || '';
  const teacherLoadLimitKey = collapsedInspector.match(/<strong>教师负载<\/strong>[\s\S]*?data-inspector-issue-limit-key="([^"]+)"/)?.[1] || '';
  assert.match(qualityLimitKey, /^review:group-/);
  assert.match(teacherLoadLimitKey, /^review:group-/);
  assert.notEqual(qualityLimitKey, teacherLoadLimitKey);

  const inspector = renderInspector(sampleWorkbenchState({
    ...baseState,
    inspectorIssueLimits: { [qualityLimitKey]: 25 },
  }));

  assert.match(inspector, /<strong>教务复核<\/strong>[\s\S]*<span>8<\/span>/);
  assert.match(inspector, /已显示\s*8\/8/);
  assert.match(inspector, /收起/);
  assert.match(inspector, /教师负载建议 5/);
  assert.doesNotMatch(inspector, /教师负载建议 6/);
  assert.match(inspector, new RegExp(`data-inspector-issue-limit-key="${teacherLoadLimitKey}"`));
});

test('timetable inspector renders locatable issue cards with target data', () => {
  const state = sampleWorkbenchState({
    schedule: {
      id: 'schedule-locatable-inspector-issues',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{ id: 'slot-locate-1', day: 2, period: 3, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues: [{
        id: 'quality-class-locate',
        severity: 'warning',
        title: '班级待复核',
        message: '八年级G8-10班需要复核。',
        targetKind: 'class',
        targetId: 'c1',
        targetName: 'G71',
        slot: { day: 2, period: 3 },
      }],
      diagnostics: { items: [], suggestions: [] },
      score: {
        hardConflicts: 0,
        unplacedLessons: 0,
        placedLessons: 1,
        totalLessons: 1,
        completeness: 100,
      },
    },
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /tt-inspector-issue-item--locatable/);
  assert.match(inspector, /data-action="locate-inspector-issue"/);
  assert.match(inspector, /data-inspector-target-kind="class"/);
  assert.match(inspector, /data-inspector-target-id="c1"/);
  assert.match(inspector, /data-inspector-day="2"/);
  assert.match(inspector, /data-inspector-period="3"/);
  assert.match(inspector, /data-inspector-issue-key="[^"]+"/);
  assert.match(inspector, />定位</);
});

test('timetable inspector marks the just-located source issue without changing the list', () => {
  const baseState = sampleWorkbenchState({
    schedule: {
      id: 'schedule-located-source-issue',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{ id: 'slot-located-source', day: 2, period: 3, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues: [{
        id: 'quality-located-source',
        severity: 'warning',
        title: '班级待复核',
        message: '八年级G8-10班需要复核。',
        targetKind: 'class',
        targetId: 'c1',
        targetName: 'G71',
        slot: { day: 2, period: 3 },
      }],
      diagnostics: { items: [], suggestions: [] },
      score: {
        hardConflicts: 0,
        unplacedLessons: 0,
        placedLessons: 1,
        totalLessons: 1,
        completeness: 100,
      },
    },
  });
  const firstRender = renderInspector(baseState);
  const issueKey = firstRender.match(/data-inspector-issue-key="([^"]+)"/)?.[1] || '';
  assert.ok(issueKey);

  const locatedRender = renderInspector({
    ...baseState,
    inspectorLocatedIssueKey: issueKey,
  });

  assert.match(locatedRender, /tt-inspector-issue-item--locatable[^"]*is-inspector-located-source/);
  assert.match(locatedRender, new RegExp(`data-inspector-issue-key="${issueKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
});

function sampleConstraintFulfillment(overrides = {}) {
  return {
    evaluated: true,
    version: 2,
    summary: {
      total: 144,
      satisfied: 128,
      partiallySatisfied: 11,
      violated: 5,
      notEvaluable: 0,
      partial: 11,
      unmet: 5,
      notApplicable: 0,
    },
    items: [
      {
        id: 'rule-unmet',
        ruleId: 'rule-unmet',
        type: 'teacher_daily_limit',
        typeLabel: '教师每日上限',
        origin: 'softRules.teacherLimits',
        priority: 'soft',
        strength: 'soft',
        status: 'violated',
        legacyStatus: 'unmet',
        title: 'Math Teacher 每天最多 1 节',
        evidence: '周一实际 2 节，超过上限 1 节。',
        detail: '周一实际 2 节，超过上限 1 节。',
        targetKind: 'teacher',
        targetId: 't_math',
        targetName: 'Math Teacher',
        evidenceSlots: [{ day: 1, period: 1, teacherId: 't_math', slotId: 'slot-1' }],
        suggestions: [{ kind: 'delete_rule', label: '删除规则' }],
      },
      {
        id: 'rule-partial',
        ruleId: 'rule-partial',
        type: 'subject_morning',
        typeLabel: '课程上午优先',
        origin: 'softRules.morningSubjects',
        priority: 'soft',
        strength: 'soft',
        status: 'partial',
        title: 'Math 上午优先',
        evidence: '1/2 节在上午。',
        detail: '1/2 节在上午。',
        targetKind: 'subject',
        targetId: 'math',
        targetName: 'Math',
        evidenceSlots: [{ day: 1, period: 4, classId: 'c1', slotId: 'slot-2' }],
        suggestions: [{ kind: 'manual', label: '人工处理' }],
      },
      {
        id: 'rule-satisfied',
        ruleId: 'rule-satisfied',
        type: 'class_unavailable',
        typeLabel: '班级不可排',
        origin: 'hardRules.classUnavailable',
        priority: 'hard',
        strength: 'hard',
        status: 'satisfied',
        title: 'G71 周二第5节不可排',
        evidence: '没有课程排入该禁排时段。',
        detail: '没有课程排入该禁排时段。',
        targetKind: 'class',
        targetId: 'c1',
        targetName: 'G71',
        evidenceSlots: [],
        suggestions: [],
      },
      {
        id: 'rule-not-applicable',
        ruleId: 'rule-not-applicable',
        type: 'subject_spread',
        typeLabel: '同科分散',
        origin: 'softRules.spreadSubjects',
        priority: 'soft',
        strength: 'soft',
        status: 'not_evaluable',
        legacyStatus: 'not_applicable',
        title: 'PE 分散排布',
        evidence: '当前课表没有 PE 课节。',
        detail: '当前课表没有 PE 课节。',
        targetKind: 'subject',
        targetId: 'pe',
        targetName: 'PE',
        evidenceSlots: [],
        suggestions: [{ kind: 'manual', label: '补齐数据' }],
      },
    ],
    ...overrides,
  };
}

test('timetable inspector renders constraint fulfillment between review and system details', () => {
  const state = sampleWorkbenchState({
    schedule: {
      id: 'schedule-constraint-fulfillment-ui',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [
        { id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
        { id: 'slot-2', day: 1, period: 4, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
      ],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues: [],
      diagnostics: { items: [], suggestions: [] },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 2, totalLessons: 2, completeness: 100 },
    },
    constraintFulfillment: sampleConstraintFulfillment(),
  });

  const inspector = renderInspector(state);
  const reviewIndex = inspector.indexOf('data-inspector-section="review"');
  const fulfillmentIndex = inspector.indexOf('data-inspector-section="constraint-fulfillment"');
  const systemIndex = inspector.indexOf('data-inspector-section="system"');

  assert.ok(reviewIndex >= 0);
  assert.ok(fulfillmentIndex > reviewIndex);
  assert.ok(systemIndex > fulfillmentIndex);
  assert.match(inspector, /约束满足度报告/);
  assert.match(inspector, /约束 144/);
  assert.match(inspector, /满足 128/);
  assert.match(inspector, /部分 11/);
  assert.match(inspector, /未满足 5/);
  assert.match(inspector, /data-constraint-fulfillment-filter="attention"[\s\S]*aria-pressed="true"/);
  assert.match(inspector, /Math Teacher 每天最多 1 节/);
  assert.match(inspector, /Math 上午优先/);
  assert.doesNotMatch(inspector, /G71 周二第5节不可排/);
  assert.match(inspector, /data-constraint-fulfillment-row="rule-unmet"/);
  assert.match(inspector, /data-constraint-fulfillment-suggestion="delete_rule"/);
  assert.match(inspector, /data-inspector-target-kind="teacher"/);
  assert.match(inspector, /data-action="locate-inspector-issue"/);
});

test('timetable inspector constraint fulfillment filter can show satisfied and not-evaluable rows', () => {
  const allInspector = renderInspector(sampleWorkbenchState({
    schedule: {
      id: 'schedule-constraint-fulfillment-all',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues: [],
      diagnostics: { items: [], suggestions: [] },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
    constraintFulfillment: sampleConstraintFulfillment(),
    constraintFulfillmentFilter: 'all',
  }));
  const notApplicableInspector = renderInspector(sampleWorkbenchState({
    schedule: {
      id: 'schedule-constraint-fulfillment-na',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues: [],
      diagnostics: { items: [], suggestions: [] },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
    constraintFulfillment: sampleConstraintFulfillment(),
    constraintFulfillmentFilter: 'not_evaluable',
  }));

  assert.match(allInspector, /data-constraint-fulfillment-filter="all"[\s\S]*aria-pressed="true"/);
  assert.match(allInspector, /G71 周二第5节不可排/);
  assert.match(allInspector, /PE 分散排布/);
  assert.match(notApplicableInspector, /PE 分散排布/);
  assert.doesNotMatch(notApplicableInspector, /Math Teacher 每天最多 1 节/);
});

test('timetable inspector constraint fulfillment does not affect header review counts and marks related review items', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    rules: { hardRules: {}, softRules: { teacherLimits: { t_math: { daily: 1 } } } },
    schedule: {
      id: 'schedule-constraint-fulfillment-related',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [
        { id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
        { id: 'slot-2', day: 1, period: 2, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
      ],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues: [{
        id: 'daily-limit-review',
        type: 'teacher_daily_limit',
        severity: 'warning',
        teacherId: 't_math',
        targetKind: 'teacher',
        targetId: 't_math',
        targetName: 'Math Teacher',
        message: 'Math Teacher 当天课时超过上限。',
        slot: { day: 1, period: 1 },
      }],
      diagnostics: { items: [], suggestions: [] },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 2, totalLessons: 2, completeness: 100 },
    },
  });
  const state = sampleWorkbenchState({
    project,
    constraintFulfillment: sampleConstraintFulfillment({
      summary: {
        total: 144,
        satisfied: 143,
        partiallySatisfied: 0,
        violated: 1,
        notEvaluable: 0,
        partial: 0,
        unmet: 1,
        notApplicable: 0,
      },
    }),
  });

  const workbench = renderWorkbench(state);
  const inspector = renderInspector(state);
  const summary = inspectorSummaryMarkup(workbench);

  assert.match(summary, /复核 1/);
  assert.doesNotMatch(summary, /复核 144/);
  assert.match(inspector, /已列入建议复核/);
  const fulfillmentMarkup = inspector.match(/data-inspector-section="constraint-fulfillment"[\s\S]*?data-inspector-section="system"/)?.[0] || '';
  assert.doesNotMatch(fulfillmentMarkup, /tt-inspector-problem-group/);
  assert.doesNotMatch(fulfillmentMarkup, /Math Teacher 当天课时超过上限。/);
});

test('timetable inspector leaves non-locatable system issues as plain cards', () => {
  const inspector = renderInspector(sampleWorkbenchState({
    schedule: {
      id: 'schedule-plain-inspector-issues',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{ id: 'slot-plain-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues: [{
        id: 'quality-system-only',
        severity: 'warning',
        title: '整体质量建议',
        message: '建议整体复核课表。',
        targetKind: 'schedule',
      }],
      diagnostics: { items: [], suggestions: [] },
      score: {
        hardConflicts: 0,
        unplacedLessons: 0,
        placedLessons: 1,
        totalLessons: 1,
        completeness: 100,
      },
    },
  }));

  assert.match(inspector, /整体质量建议/);
  assert.doesNotMatch(inspector, /data-action="locate-inspector-issue"/);
  assert.doesNotMatch(inspector, /tt-inspector-issue-item--locatable/);
});

test('timetable inspector issue expand actions update only the clicked group limit', async () => {
  const stateSource = await readFile(new URL('state.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');
  const listeners = {};
  const container = {
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const state = { inspectorIssueLimits: {} };
  let renderCount = 0;
  const controller = {
    render() {
      renderCount += 1;
    },
  };
  const expandButton = {
    dataset: {
      action: 'expand-inspector-issue-group',
      inspectorIssueLimitKey: 'review:publication',
      inspectorIssueShown: '5',
      inspectorIssueTotal: '42',
    },
  };
  const collapseButton = {
    dataset: {
      action: 'collapse-inspector-issue-group',
      inspectorIssueLimitKey: 'review:publication',
      inspectorIssueShown: '25',
      inspectorIssueTotal: '42',
    },
  };

  bindGridInteractions(container, controller, state);
  listeners.click({
    target: {
      matches() {
        return false;
      },
      closest(selector) {
        if (selector === '[data-action]' || selector === '[data-inspector-issue-limit-key]') return expandButton;
        return null;
      },
    },
    preventDefault() {},
    stopPropagation() {},
  });

  assert.equal(state.inspectorIssueLimits['review:publication'], 25);
  assert.equal(renderCount, 1);

  listeners.click({
    target: {
      matches() {
        return false;
      },
      closest(selector) {
        if (selector === '[data-action]' || selector === '[data-inspector-issue-limit-key]') return collapseButton;
        return null;
      },
    },
    preventDefault() {},
    stopPropagation() {},
  });

  assert.deepEqual(state.inspectorIssueLimits, {});
  assert.equal(renderCount, 2);
  assert.match(stateSource, /inspectorIssueLimits:\s*\{\}/);
  assert.match(interactionSource, /expand-inspector-issue-group/);
  assert.match(interactionSource, /collapse-inspector-issue-group/);
  assert.match(styles, /\.tt-inspector-list-actions\s*{/);
  assert.match(styles, /\.tt-inspector-list-action\s*{/);
});

test('timetable inspector constraint fulfillment filter action updates state only', async () => {
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const listeners = {};
  const container = {
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const state = { constraintFulfillmentFilter: 'attention' };
  let renderCount = 0;
  const controller = {
    render() {
      renderCount += 1;
    },
  };
  const filterButton = {
    dataset: {
      action: 'filter-constraint-fulfillment',
      constraintFulfillmentFilter: 'all',
    },
  };

  bindGridInteractions(container, controller, state);
  listeners.click({
    target: {
      matches() {
        return false;
      },
      closest(selector) {
        if (selector === '[data-action]') return filterButton;
        return null;
      },
    },
    preventDefault() {},
    stopPropagation() {},
  });

  assert.equal(state.constraintFulfillmentFilter, 'all');
  assert.equal(renderCount, 1);
  assert.match(interactionSource, /filter-constraint-fulfillment/);
});

test('timetable inspector constraint fulfillment actions delegate rerun and suggestions', async () => {
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const listeners = {};
  const container = {
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const state = {};
  let rerunCount = 0;
  let suggestionPayload = null;
  const controller = {
    runSchedule() {
      rerunCount += 1;
    },
    handleConstraintFulfillmentSuggestion(ruleId, kind) {
      suggestionPayload = { ruleId, kind };
    },
  };
  const rerunButton = {
    dataset: { action: 'rerun-constraint-fulfillment' },
  };
  const suggestionButton = {
    dataset: {
      action: 'constraint-fulfillment-suggestion',
      constraintFulfillmentRow: 'rule-unmet',
      constraintFulfillmentSuggestion: 'delete_rule',
    },
  };

  bindGridInteractions(container, controller, state);
  listeners.click({
    target: {
      matches() {
        return false;
      },
      closest(selector) {
        if (selector === '[data-action]') return rerunButton;
        return null;
      },
    },
    preventDefault() {},
    stopPropagation() {},
  });
  listeners.click({
    target: {
      matches() {
        return false;
      },
      closest(selector) {
        if (selector === '[data-action]') return suggestionButton;
        return null;
      },
    },
    preventDefault() {},
    stopPropagation() {},
  });

  assert.equal(rerunCount, 1);
  assert.deepEqual(suggestionPayload, { ruleId: 'rule-unmet', kind: 'delete_rule' });
  assert.match(interactionSource, /rerun-constraint-fulfillment/);
  assert.match(interactionSource, /constraint-fulfillment-suggestion/);
});

test('timetable inspector locate action delegates target data to the controller', () => {
  const listeners = {};
  const container = {
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const state = {};
  const inspectorBody = {
    scrollTop: 300,
    getBoundingClientRect() {
      return { top: 100 };
    },
  };
  const locateNode = {
    dataset: {
      action: 'locate-inspector-issue',
      inspectorIssueKey: 'review:quality:quality-anchor',
      inspectorTargetKind: 'class',
      inspectorTargetId: 'c1',
      inspectorTargetName: 'G71',
      inspectorDay: '2',
      inspectorPeriod: '3',
    },
    getBoundingClientRect() {
      return { top: 260 };
    },
    closest(selector) {
      if (selector === '.tt-inspector-body') return inspectorBody;
      return null;
    },
  };
  let payload = null;
  const controller = {
    locateInspectorIssue(nextPayload) {
      payload = nextPayload;
      return true;
    },
  };
  let prevented = false;
  let stopped = false;

  bindGridInteractions(container, controller, state);
  listeners.click({
    target: {
      matches() {
        return false;
      },
      closest(selector) {
        if (selector === '[data-action]') return locateNode;
        return null;
      },
    },
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
  });

  assert.equal(payload.inspectorTargetKind, 'class');
  assert.equal(payload.inspectorTargetId, 'c1');
  assert.equal(payload.inspectorDay, '2');
  assert.equal(payload.inspectorPeriod, '3');
  assert.equal(payload.inspectorIssueKey, 'review:quality:quality-anchor');
  assert.equal(payload.inspectorAnchorScrollTop, 300);
  assert.equal(payload.inspectorAnchorOffsetTop, 160);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});

test('timetable inspector locate switches class, teacher and slot-only targets', () => {
  const controller = new TimetablePlannerController();
  controller.state.project = createDefaultTimetableProject({
    schoolName: 'Locate School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [
      { id: 'c1', grade: 'G7', name: '1' },
      { id: 'c2', grade: '八年级', name: 'G8-10班' },
    ],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math_c2', classId: 'c2', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'schedule-locate-controller',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{
        id: 'slot-locate-c2',
        day: 2,
        period: 3,
        classId: 'c2',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math_c2',
      }],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues: [],
      diagnostics: { items: [], suggestions: [] },
      score: {
        hardConflicts: 0,
        unplacedLessons: 0,
        placedLessons: 1,
        totalLessons: 1,
        completeness: 100,
      },
    },
  });
  controller.state.viewMode = 'class';
  controller.state.selectedOwnerId = 'c1';
  controller.state.inspectorIssueLimits = { 'review:quality': 25 };
  let renderCount = 0;
  controller.render = () => {
    renderCount += 1;
  };

  assert.equal(controller.locateInspectorIssue({
    targetKind: 'class',
    targetName: '八年级G8-10班',
    day: '2',
    period: '3',
  }), true);
  assert.equal(controller.state.viewMode, 'class');
  assert.equal(controller.state.selectedOwnerId, 'c2');
  assert.equal(controller.state.selectedSlotId, 'slot-locate-c2');
  assert.match(controller.state.message, /已定位到 八年级G8-10班/);
  assert.deepEqual(controller.state.inspectorIssueLimits, { 'review:quality': 25 });

  assert.equal(controller.locateInspectorIssue({
    targetKind: 'teacher',
    targetName: 'Math Teacher',
    day: '2',
    period: '3',
  }), true);
  assert.equal(controller.state.viewMode, 'teacher');
  assert.equal(controller.state.selectedOwnerId, 't_math');
  assert.equal(controller.state.selectedSlotId, 'slot-locate-c2');

  assert.equal(controller.locateInspectorIssue({
    day: '2',
    period: '3',
  }), true);
  assert.equal(controller.state.viewMode, 'master');
  assert.equal(controller.state.selectedOwnerId, 'master');
  assert.equal(controller.state.inspectorLocatePulse.day, 2);
  assert.equal(controller.state.inspectorLocatePulse.period, 3);
  assert.equal(renderCount, 3);
});

test('timetable inspector locate preserves the inspector scroll anchor across rerender', () => {
  const controller = new TimetablePlannerController();
  controller.state.project = createDefaultTimetableProject({
    schoolName: 'Locate Scroll School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [
      { id: 'c1', grade: 'G7', name: '1' },
      { id: 'c2', grade: '八年级', name: 'G8-10班' },
    ],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math_c2', classId: 'c2', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'schedule-locate-scroll',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{
        id: 'slot-locate-scroll',
        day: 2,
        period: 3,
        classId: 'c2',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math_c2',
      }],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues: [],
      diagnostics: { items: [], suggestions: [] },
      score: {
        hardConflicts: 0,
        unplacedLessons: 0,
        placedLessons: 1,
        totalLessons: 1,
        completeness: 100,
      },
    },
  });
  const inspectorBody = {
    scrollTop: 0,
    getBoundingClientRect() {
      return { top: 100 };
    },
    querySelector(selector) {
      if (selector === '[data-inspector-issue-key="issue-scroll-key"]') {
        return {
          getBoundingClientRect() {
            return { top: 340 };
          },
        };
      }
      return null;
    },
  };
  const scheduleSlot = {
    classList: {
      contains(value) {
        return value === 'tt-slot';
      },
    },
    focus() {},
    scrollIntoView() {},
  };
  controller.state.container = {
    querySelector(selector) {
      if (selector === '.tt-inspector-body') return inspectorBody;
      if (selector === '.tt-slot[data-slot-id="slot-locate-scroll"]') return scheduleSlot;
      if (selector === '.tt-schedule-scroll') return { scrollIntoView() {} };
      return null;
    },
  };
  let renderCount = 0;
  controller.render = () => {
    renderCount += 1;
  };

  assert.equal(controller.locateInspectorIssue({
    targetKind: 'class',
    targetId: 'c2',
    targetName: '八年级G8-10班',
    day: '2',
    period: '3',
    inspectorIssueKey: 'issue-scroll-key',
    inspectorAnchorScrollTop: '300',
    inspectorAnchorOffsetTop: '160',
  }), true);

  assert.equal(controller.state.selectedSlotId, 'slot-locate-scroll');
  assert.equal(controller.state.inspectorLocatedIssueKey, 'issue-scroll-key');
  assert.equal(inspectorBody.scrollTop, 80);
  assert.equal(renderCount, 1);
});

test('timetable inspector locate pulse is rendered on matching schedule slots and cells', async () => {
  const stateSource = await readFile(new URL('state.js', moduleRoot), 'utf8');
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');
  const state = sampleWorkbenchState({
    inspectorLocatePulse: {
      kind: 'slot',
      slotId: 'slot-pulse-1',
      day: 2,
      period: 3,
      ownerId: 'c1',
      viewMode: 'class',
    },
    schedule: {
      id: 'schedule-locate-pulse',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{ id: 'slot-pulse-1', day: 2, period: 3, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues: [],
      diagnostics: { items: [], suggestions: [] },
      score: {
        hardConflicts: 0,
        unplacedLessons: 0,
        placedLessons: 1,
        totalLessons: 1,
        completeness: 100,
      },
    },
  });

  const panel = renderSchedulePanel(state);

  assert.match(panel, /tt-cell[^"]*is-inspector-locate-pulse[^"]*" data-day="2" data-period="3"/);
  assert.match(panel, /tt-slot[^"]*is-inspector-locate-pulse/);
  assert.match(stateSource, /inspectorLocatePulse:\s*null/);
  assert.match(controllerSource, /locateInspectorIssue\(/);
  assert.match(interactionSource, /locate-inspector-issue/);
  assert.match(styles, /\.tt-inspector-issue-item--locatable/);
  assert.match(styles, /\.is-inspector-locate-pulse/);
});

test('timetable inspector keeps selected slot actions inside the current slot section', () => {
  const state = sampleWorkbenchState({
    selectedSlotId: 'slot-selected',
    schedule: {
      id: 'schedule-selected-slot',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{
        id: 'slot-selected',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
      }],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues: [],
      diagnostics: { items: [], suggestions: [] },
      score: {
        hardConflicts: 0,
        unplacedLessons: 0,
        placedLessons: 3,
        totalLessons: 3,
        completeness: 100,
      },
    },
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /当前课节/);
  assert.match(inspector, /Math/);
  assert.match(inspector, /锁定整段/);
  assert.match(inspector, /清空整段/);
  assert.doesNotMatch(inspector, /课节检查/);
});

test('timetable inspector applies default section expansion rules', () => {
  const blockingInspector = renderInspector(sampleWorkbenchState({
    schedule: {
      id: 'schedule-blocking-default-open',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      lockedSlots: [],
      unplaced: [{ lessonPlanId: 'lp_math', reason: 'No slot' }],
      conflicts: [],
      qualityIssues: [{ id: 'quality-1', severity: 'warning', type: 'manual_review', message: '请教务复核排课质量。' }],
      diagnostics: { items: [], suggestions: [] },
      score: {
        hardConflicts: 0,
        unplacedLessons: 1,
        placedLessons: 1,
        totalLessons: 2,
        completeness: 50,
      },
    },
  }));
  const blockingTag = blockingInspector.match(/<details[^>]+data-inspector-section="blocking"[^>]*>/)?.[0] || '';
  const blockingReviewTag = blockingInspector.match(/<details[^>]+data-inspector-section="review"[^>]*>/)?.[0] || '';
  const blockingSystemTag = blockingInspector.match(/<details[^>]+data-inspector-section="system"[^>]*>/)?.[0] || '';

  assert.match(blockingTag, /open/);
  assert.match(blockingReviewTag, /open/);
  assert.doesNotMatch(blockingSystemTag, /open/);

  const reviewInspector = renderInspector(sampleWorkbenchState({
    schedule: {
      id: 'schedule-review-default-open',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [
        { id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
        { id: 'slot-2', day: 2, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
        { id: 'slot-3', day: 3, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
      ],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues: [{ id: 'quality-1', severity: 'warning', type: 'manual_review', message: '请教务复核排课质量。' }],
      diagnostics: { items: [], suggestions: [] },
      score: {
        hardConflicts: 0,
        unplacedLessons: 0,
        placedLessons: 3,
        totalLessons: 3,
        completeness: 100,
      },
    },
  }));
  const reviewBlockingTag = reviewInspector.match(/<details[^>]+data-inspector-section="blocking"[^>]*>/)?.[0] || '';
  const reviewTag = reviewInspector.match(/<details[^>]+data-inspector-section="review"[^>]*>/)?.[0] || '';
  const reviewSystemTag = reviewInspector.match(/<details[^>]+data-inspector-section="system"[^>]*>/)?.[0] || '';

  assert.doesNotMatch(reviewBlockingTag, /open/);
  assert.match(reviewTag, /open/);
  assert.doesNotMatch(reviewSystemTag, /open/);

  const selectedInspector = renderInspector(sampleWorkbenchState({
    selectedSlotId: 'slot-selected',
    schedule: {
      id: 'schedule-selected-default-open',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{
        id: 'slot-selected',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
      }],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues: [],
      diagnostics: { items: [], suggestions: [] },
      score: {
        hardConflicts: 0,
        unplacedLessons: 0,
        placedLessons: 3,
        totalLessons: 3,
        completeness: 100,
      },
    },
  }));
  const selectedTag = selectedInspector.match(/<details[^>]+data-inspector-section="current-slot"[^>]*>/)?.[0] || '';

  assert.match(selectedTag, /open/);
});

test('timetable inspector system details render summaries without duplicate issue lists', () => {
  const inspector = renderInspector(sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: { teacherLimits: { t_math: { consecutive: 2 } } } },
      schedule: {
        id: 'schedule-system-summary-only',
        generatedAt: '2026-01-02T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
        lockedSlots: [],
        unplaced: [],
        conflicts: [],
        audit: {
          blockingIssues: [],
          warnings: [{ type: 'teacher_load', teacherId: 't_math', message: 'Math Teacher 负载接近满载。' }],
        },
        publication: {
          ok: true,
          reason: 'ready',
          issueEntries: [{ type: 'manual_adjusted', severity: 'warning', targetKind: 'schedule', targetName: '课表', message: '课表包含手动调整，发布前建议复核锁定课节。' }],
          reviewItems: [{ type: 'manual_adjusted', severity: 'warning', targetKind: 'schedule', targetName: '课表', message: '课表包含手动调整，发布前建议复核锁定课节。' }],
          summary: { totalLessons: 3, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
        },
        qualityIssues: [
          { id: 'teacher-consecutive', severity: 'warning', type: 'teacher_consecutive', teacherId: 't_math', message: 'Math Teacher 连续授课偏多。' },
        ],
        diagnostics: {
          diagnosticsVersion: 1,
          summary: { error: 0, warning: 1, info: 0, total: 1, suggestions: 1 },
          items: [{
            id: 'diag-teacher-load',
            category: 'quality',
            type: 'teacher_load',
            severity: 'warning',
            targetKind: 'teacher',
            targetId: 't_math',
            targetName: 'Math Teacher',
            message: 'Math Teacher 负载接近满载。',
          }],
          suggestions: [{
            id: 'sug-teacher-load',
            kind: 'quality',
            targetDiagnostics: ['diag-teacher-load'],
            targetKind: 'teacher',
            targetId: 't_math',
            targetName: 'Math Teacher',
            message: '复核 Math Teacher 的软规则表现，必要时调整偏好或接受当前结果。',
          }],
        },
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 3, completeness: 33 },
      },
    }),
  }));
  const systemMarkup = inspectorSystemMarkup(inspector);

  assert.match(inspector, /Math Teacher 负载接近满载。/);
  assert.match(inspector, /课表包含手动调整，发布前建议复核锁定课节。/);
  assert.match(inspector, /Math Teacher 连续授课偏多。/);
  assert.match(systemMarkup, /数据摘要/);
  assert.match(systemMarkup, /生成详情/);
  assert.match(systemMarkup, /发布详情/);
  assert.doesNotMatch(systemMarkup, /发布问题/);
  assert.doesNotMatch(systemMarkup, /排课诊断/);
  assert.doesNotMatch(systemMarkup, /诊断报告/);
  assert.doesNotMatch(systemMarkup, /质量建议/);
  assert.doesNotMatch(systemMarkup, /诊断明细/);
  assert.doesNotMatch(systemMarkup, /诊断建议/);
  assert.doesNotMatch(systemMarkup, /tt-inspector-problem-group/);
  assert.doesNotMatch(systemMarkup, /data-action="locate-inspector-issue"/);
  assert.doesNotMatch(systemMarkup, /复核 Math Teacher 的软规则表现/);
});

test('timetable inspector summary reports actionable counts in the floating header', () => {
  const blockingHtml = renderWorkbench(sampleWorkbenchState({
    schedule: {
      id: 'schedule-inspector-header-counts',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      lockedSlots: [],
      unplaced: [{ lessonPlanId: 'lp_math', reason: 'No slot' }],
      conflicts: [],
      qualityIssues: [
        { id: 'quality-1', severity: 'warning', type: 'manual_review', message: '请教务复核排课质量。' },
        { id: 'quality-2', severity: 'warning', type: 'teacher_load', message: 'Math Teacher 负载偏高。' },
      ],
      diagnostics: { items: [], suggestions: [] },
      score: {
        hardConflicts: 0,
        unplacedLessons: 1,
        placedLessons: 1,
        totalLessons: 2,
        completeness: 50,
      },
    },
  }));
  const blockingSummary = inspectorSummaryMarkup(blockingHtml);

  assert.match(blockingSummary, /需处理 1 · 复核 2/);
  assert.doesNotMatch(blockingSummary, /诊断 \/ 质量 \/ 发布/);

  const publishableHtml = renderWorkbench(sampleWorkbenchState({
    schedule: {
      id: 'schedule-inspector-header-publishable',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      qualityIssues: [],
      diagnostics: { items: [], suggestions: [] },
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      score: {
        hardConflicts: 0,
        unplacedLessons: 0,
        placedLessons: 1,
        totalLessons: 1,
        completeness: 100,
      },
    },
  }));
  assert.match(inspectorSummaryMarkup(publishableHtml), /可发布/);

  const notGeneratedHtml = renderWorkbench(sampleWorkbenchState({ schedule: null }));
  assert.match(inspectorSummaryMarkup(notGeneratedHtml), /未生成/);
});

test('timetable inspector ignores legacy full-class load warnings', () => {
  const fullClassOnlySchedule = {
    id: 'schedule-legacy-class-load',
    generatedAt: '2026-01-02T00:00:00.000Z',
    source: 'fast_constructed',
    slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
    lockedSlots: [],
    unplaced: [],
    conflicts: [],
    audit: {
      blockingIssues: [],
      warnings: [{ type: 'class_load', message: '班级课表接近满载。', classId: 'c1', name: 'G71', utilization: 100 }],
      bottlenecks: { classes: [{ id: 'c1', name: 'G71', utilization: 100 }] },
      capacity: { totalLessons: 1, availableSlots: 1, classCapacity: 1, utilization: 100 },
    },
    publication: {
      ok: true,
      reason: 'ready',
      issueEntries: [
        { type: 'class_load', severity: 'warning', targetKind: 'class', targetId: 'c1', targetName: 'G71', message: '班级课表接近满载。' },
      ],
      reviewItems: [
        { type: 'class_load', severity: 'warning', targetKind: 'class', targetId: 'c1', targetName: 'G71', message: '班级课表接近满载。' },
      ],
      blockingIssues: [],
      warnings: [],
      summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
    },
    qualityIssues: [],
    diagnostics: { items: [], suggestions: [] },
    score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
  };

  const model = buildInspectorViewModel(sampleWorkbenchState({ schedule: fullClassOnlySchedule }));
  const workbench = renderWorkbench(sampleWorkbenchState({ schedule: fullClassOnlySchedule }));
  const inspector = renderInspector(sampleWorkbenchState({ schedule: fullClassOnlySchedule }));

  assert.equal(model.reviewItems.length, 0);
  assert.match(inspectorSummaryMarkup(workbench), /可发布/);
  assert.doesNotMatch(inspector, /班级课表接近满载。/);
  assert.doesNotMatch(inspector, /班级负载/);

  const mixedInspector = renderInspector(sampleWorkbenchState({
    schedule: {
      ...fullClassOnlySchedule,
      id: 'schedule-legacy-class-load-with-teacher',
      audit: {
        ...fullClassOnlySchedule.audit,
        warnings: [
          ...fullClassOnlySchedule.audit.warnings,
          { type: 'teacher_load', message: 'Math Teacher 负载较高。', teacherId: 't_math', name: 'Math Teacher', utilization: 100 },
        ],
      },
      publication: {
        ...fullClassOnlySchedule.publication,
        issueEntries: [
          ...fullClassOnlySchedule.publication.issueEntries,
          { type: 'teacher_load', severity: 'warning', targetKind: 'teacher', targetId: 't_math', targetName: 'Math Teacher', message: 'Math Teacher 负载较高。' },
        ],
        reviewItems: [
          ...fullClassOnlySchedule.publication.reviewItems,
          { type: 'teacher_load', severity: 'warning', targetKind: 'teacher', targetId: 't_math', targetName: 'Math Teacher', message: 'Math Teacher 负载较高。' },
        ],
      },
    },
  }));

  assert.match(mixedInspector, /Math Teacher 负载较高。/);
  assert.match(mixedInspector, /教师负载/);
  assert.doesNotMatch(mixedInspector, /班级课表接近满载。/);
});

test('timetable inspector ignores legacy subject spread review noise', () => {
  const subjectSpreadOnlySchedule = {
    id: 'schedule-legacy-subject-spread',
    generatedAt: '2026-01-02T00:00:00.000Z',
    source: 'fast_constructed',
    slots: [
      { id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
      { id: 'slot-2', day: 1, period: 2, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
    ],
    lockedSlots: [],
    unplaced: [],
    conflicts: [],
    audit: { blockingIssues: [], warnings: [], bottlenecks: {}, capacity: { totalLessons: 2, availableSlots: 35 } },
    publication: {
      ok: true,
      reason: 'ready',
      issueEntries: [
        { type: 'subject_spread', severity: 'warning', targetKind: 'class', targetId: 'c1', targetName: 'G71', message: 'Math 同一天过于集中。' },
      ],
      reviewItems: [
        { type: 'subject_spread', severity: 'warning', targetKind: 'class', targetId: 'c1', targetName: 'G71', message: 'Math 同一天过于集中。' },
      ],
      blockingIssues: [],
      warnings: [],
      summary: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0 },
    },
    qualityIssues: [
      { id: 'quality-spread', severity: 'warning', type: 'subject_spread', message: 'Math 同一天过于集中。', slot: { day: 1, period: 1 } },
    ],
    diagnostics: { items: [], suggestions: [] },
    score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 2, totalLessons: 2, completeness: 100 },
  };

  const model = buildInspectorViewModel(sampleWorkbenchState({ schedule: subjectSpreadOnlySchedule }));
  const workbench = renderWorkbench(sampleWorkbenchState({ schedule: subjectSpreadOnlySchedule }));
  const inspector = renderInspector(sampleWorkbenchState({ schedule: subjectSpreadOnlySchedule }));

  assert.equal(model.reviewItems.length, 0);
  assert.match(inspectorSummaryMarkup(workbench), /可发布/);
  assert.doesNotMatch(inspector, /同科分散/);
  assert.doesNotMatch(inspector, /同一天过于集中/);

  const mixedInspector = renderInspector(sampleWorkbenchState({
    schedule: {
      ...subjectSpreadOnlySchedule,
      id: 'schedule-legacy-subject-spread-with-teacher',
      qualityIssues: [
        ...subjectSpreadOnlySchedule.qualityIssues,
        { id: 'manual-review', severity: 'warning', type: 'manual_review', message: '请教务复核排课质量。' },
      ],
      publication: {
        ...subjectSpreadOnlySchedule.publication,
        issueEntries: [
          ...subjectSpreadOnlySchedule.publication.issueEntries,
          { type: 'manual_review', severity: 'warning', targetKind: 'schedule', targetName: '课表', message: '请教务复核排课质量。' },
        ],
        reviewItems: [
          ...subjectSpreadOnlySchedule.publication.reviewItems,
          { type: 'manual_review', severity: 'warning', targetKind: 'schedule', targetName: '课表', message: '请教务复核排课质量。' },
        ],
      },
    },
  }));

  assert.match(mixedInspector, /请教务复核排课质量。/);
  assert.match(mixedInspector, /教务复核/);
  assert.doesNotMatch(mixedInspector, /同一天过于集中/);
});

test('timetable inspector ignores legacy default teacher consecutive review noise', () => {
  const legacySchedule = {
    id: 'schedule-legacy-teacher-consecutive',
    generatedAt: '2026-01-02T00:00:00.000Z',
    source: 'fast_constructed',
    slots: [
      { id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
      { id: 'slot-2', day: 1, period: 2, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
      { id: 'slot-3', day: 1, period: 3, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
      { id: 'slot-4', day: 1, period: 4, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
    ],
    lockedSlots: [],
    unplaced: [],
    conflicts: [],
    publication: {
      ok: true,
      reason: 'ready',
      issueEntries: [
        { type: 'teacher_consecutive', severity: 'warning', targetKind: 'teacher', targetId: 't_math', targetName: 'Math Teacher', message: 'Math Teacher 连续授课偏多。' },
      ],
      reviewItems: [
        { type: 'teacher_consecutive', severity: 'warning', targetKind: 'teacher', targetId: 't_math', targetName: 'Math Teacher', message: 'Math Teacher 连续授课偏多。' },
      ],
      blockingIssues: [],
      warnings: [],
      summary: { totalLessons: 4, placedLessons: 4, unplacedLessons: 0, hardConflicts: 0 },
    },
    qualityIssues: [
      { id: 'teacher-consecutive', severity: 'warning', type: 'teacher_consecutive', teacherId: 't_math', message: 'Math Teacher 连续授课偏多。' },
    ],
    diagnostics: { items: [], suggestions: [] },
    score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 4, totalLessons: 4, completeness: 100 },
  };

  const state = sampleWorkbenchState({ schedule: legacySchedule });
  const model = buildInspectorViewModel(state);
  const workbench = renderWorkbench(state);
  const inspector = renderInspector(state);

  assert.equal(model.reviewItems.length, 0);
  assert.match(inspectorSummaryMarkup(workbench), /可发布/);
  assert.doesNotMatch(inspector, /教师连续课/);
  assert.doesNotMatch(inspector, /连续授课偏多/);
});

test('timetable inspector keeps teacher consecutive review for explicit limit', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 4 }],
    rules: { hardRules: {}, softRules: { teacherLimits: { t_math: { consecutive: 2 } } } },
    schedule: {
      id: 'schedule-explicit-teacher-consecutive',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [
        { id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
        { id: 'slot-2', day: 1, period: 2, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
        { id: 'slot-3', day: 1, period: 3, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
        { id: 'slot-4', day: 1, period: 4, classId: 'c1', subjectId: 'math', teacherId: 't_math' },
      ],
      lockedSlots: [],
      unplaced: [],
      conflicts: [],
      publication: {
        ok: true,
        reason: 'ready',
        issueEntries: [
          { type: 'teacher_consecutive', severity: 'warning', targetKind: 'teacher', targetId: 't_math', targetName: 'Math Teacher', message: 'Math Teacher 连续授课偏多。' },
        ],
        reviewItems: [
          { type: 'teacher_consecutive', severity: 'warning', targetKind: 'teacher', targetId: 't_math', targetName: 'Math Teacher', message: 'Math Teacher 连续授课偏多。' },
        ],
        blockingIssues: [],
        warnings: [],
        summary: { totalLessons: 4, placedLessons: 4, unplacedLessons: 0, hardConflicts: 0 },
      },
      qualityIssues: [
        { id: 'teacher-consecutive', severity: 'warning', type: 'teacher_consecutive', teacherId: 't_math', message: 'Math Teacher 连续授课偏多。' },
      ],
      diagnostics: { items: [], suggestions: [] },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 4, totalLessons: 4, completeness: 100 },
    },
  });

  const inspector = renderInspector(sampleWorkbenchState({ project }));

  assert.match(inspector, /Math Teacher 连续授课偏多。/);
  assert.match(inspector, /教师连续课/);
});

test('timetable inspector deduplicates the same review across publication diagnostics and quality sources', () => {
  const duplicatedReview = {
    severity: 'warning',
    type: 'manual_review',
    targetKind: 'class',
    targetId: 'c1',
    targetName: '八年级G8-10班',
    message: '发布前请人工复核。',
    slot: '2-3',
  };
  const schedule = {
    id: 'schedule-duplicated-review-sources',
    generatedAt: '2026-01-02T00:00:00.000Z',
    source: 'fast_constructed',
    slots: [{ id: 'slot-1', day: 2, period: 3, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
    lockedSlots: [],
    unplaced: [],
    conflicts: [],
    publication: {
      ok: true,
      reason: 'ready',
      issueEntries: [{ ...duplicatedReview, id: 'publication-review' }],
      reviewItems: [{ ...duplicatedReview, id: 'publication-review' }],
      blockingIssues: [],
      warnings: [],
      summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
    },
    diagnostics: {
      items: [{ ...duplicatedReview, id: 'diagnostic-review', category: 'quality' }],
      suggestions: [],
    },
    qualityIssues: [{ ...duplicatedReview, id: 'quality-review', slot: { day: 2, period: 3 } }],
    score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
  };

  const state = sampleWorkbenchState({ schedule });
  const model = buildInspectorViewModel(state);
  const inspector = renderInspector(state);
  const reviewStart = inspector.indexOf('data-inspector-section="review"');
  const systemStart = inspector.indexOf('data-inspector-section="system"', reviewStart);
  const reviewMarkup = inspector.slice(reviewStart, systemStart);
  const groupCount = (reviewMarkup.match(/tt-inspector-problem-group/g) || []).length;

  assert.equal(model.reviewItems.length, 1);
  assert.equal(groupCount, 1);
  assert.match(inspector, /发布前请人工复核。/);
});

test('timetable inspector ignores legacy morning subject review noise', () => {
  const morningIssue = {
    severity: 'info',
    type: 'morning_subject_late',
    targetKind: 'class',
    targetId: 'c1',
    targetName: '八年级G8-10班',
    message: '物理 未排在上午优先时段。',
    slot: '1-5',
  };
  const schedule = {
    id: 'schedule-legacy-morning-subject',
    generatedAt: '2026-01-02T00:00:00.000Z',
    source: 'fast_constructed',
    slots: [{ id: 'slot-1', day: 1, period: 5, classId: 'c1', subjectId: 'physics', teacherId: 't_math' }],
    lockedSlots: [],
    unplaced: [],
    conflicts: [],
    publication: {
      ok: true,
      reason: 'ready',
      issueEntries: [{ ...morningIssue, id: 'publication-morning' }],
      reviewItems: [{ ...morningIssue, id: 'publication-morning' }],
      blockingIssues: [],
      warnings: [],
      summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
    },
    diagnostics: {
      items: [{ ...morningIssue, id: 'diagnostic-morning', category: 'quality' }],
      suggestions: [],
    },
    qualityIssues: [{ ...morningIssue, id: 'quality-morning', classId: 'c1', subjectId: 'physics', slot: { day: 1, period: 5 } }],
    score: {
      hardConflicts: 0,
      unplacedLessons: 0,
      placedLessons: 1,
      totalLessons: 1,
      completeness: 100,
    },
  };

  const state = sampleWorkbenchState({ schedule });
  const model = buildInspectorViewModel(state);
  const workbench = renderWorkbench(state);
  const inspector = renderInspector(state);

  assert.equal(model.reviewItems.length, 0);
  assert.match(inspectorSummaryMarkup(workbench), /可发布/);
  assert.doesNotMatch(inspector, /主科时段/);
  assert.doesNotMatch(inspector, /未排在上午优先时段/);
});

test('timetable inspector ignores legacy diagnostics suggestions noise', () => {
  const legacyDiagnostics = {
    diagnosticsVersion: 1,
    summary: { error: 0, warning: 4, info: 0, total: 4, suggestions: 4 },
    items: [
      {
        id: 'diag-class-load',
        category: 'audit',
        source: 'schedule.audit.warnings',
        type: 'class_load',
        severity: 'warning',
        targetKind: 'class',
        targetId: 'c1',
        targetName: 'G71',
        message: '班级课表接近满载。',
      },
      {
        id: 'diag-subject-spread',
        category: 'quality',
        source: 'schedule.qualityIssues',
        type: 'subject_spread',
        severity: 'warning',
        targetKind: 'class',
        targetId: 'c1',
        targetName: 'G71',
        message: 'Math 同一天过于集中。',
      },
      {
        id: 'diag-morning',
        category: 'quality',
        source: 'schedule.qualityIssues',
        type: 'morning_subject_late',
        severity: 'info',
        targetKind: 'class',
        targetId: 'c1',
        targetName: 'G71',
        message: 'Math 未排在上午优先时段。',
      },
      {
        id: 'diag-teacher-consecutive',
        category: 'quality',
        source: 'schedule.qualityIssues',
        type: 'teacher_consecutive',
        severity: 'warning',
        targetKind: 'teacher',
        targetId: 't_math',
        targetName: 'Math Teacher',
        message: 'Math Teacher 连续授课偏多。',
      },
    ],
    suggestions: [
      { id: 'sug-class-load', kind: 'audit', targetDiagnostics: ['diag-class-load'], targetKind: 'class', targetId: 'c1', targetName: 'G71', message: '复核 G71 的相关数据。' },
      { id: 'sug-subject-spread', kind: 'quality', targetDiagnostics: ['diag-subject-spread'], targetKind: 'class', targetId: 'c1', targetName: 'G71', message: '复核 G71 的软规则表现，必要时调整偏好或接受当前结果。' },
      { id: 'sug-morning', kind: 'quality', targetDiagnostics: ['diag-morning'], targetKind: 'class', targetId: 'c1', targetName: 'G71', message: '发布前先处理 G71 的阻断项，再重新检查课表。' },
      { id: 'sug-teacher-consecutive', kind: 'quality', targetDiagnostics: ['diag-teacher-consecutive'], targetKind: 'teacher', targetId: 't_math', targetName: 'Math Teacher', message: '复核 Math Teacher 的软规则表现，必要时调整偏好或接受当前结果。' },
    ],
  };
  const schedule = {
    id: 'schedule-legacy-diagnostics-suggestions',
    generatedAt: '2026-01-02T00:00:00.000Z',
    source: 'fast_constructed',
    slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
    lockedSlots: [],
    unplaced: [],
    conflicts: [],
    audit: { blockingIssues: [], warnings: [] },
    publication: { ok: true, reason: 'ready', issueEntries: [], reviewItems: [], summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 } },
    qualityIssues: [],
    diagnostics: legacyDiagnostics,
    score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
  };

  const state = sampleWorkbenchState({ schedule });
  const model = buildInspectorViewModel(state);
  const workbench = renderWorkbench(state);
  const inspector = renderInspector(state);

  assert.equal(model.reviewItems.length, 0);
  assert.match(inspectorSummaryMarkup(workbench), /可发布/);
  assert.doesNotMatch(inspector, /tt-inspector-problem-group[\s\S]*<strong>建议<\/strong>/);
  assert.doesNotMatch(inspector, /班级课表接近满载/);
  assert.doesNotMatch(inspector, /同一天过于集中/);
  assert.doesNotMatch(inspector, /未排在上午优先时段/);
  assert.doesNotMatch(inspector, /连续授课偏多/);
  assert.doesNotMatch(inspector, /发布前先处理 G71/);
});

test('timetable inspector keeps actionable diagnostics issues in review without repeating suggestions', () => {
  const schedule = {
    id: 'schedule-actionable-diagnostics-suggestion',
    generatedAt: '2026-01-02T00:00:00.000Z',
    source: 'fast_constructed',
    slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
    lockedSlots: [],
    unplaced: [],
    conflicts: [],
    audit: { blockingIssues: [], warnings: [] },
    publication: { ok: true, reason: 'ready', issueEntries: [], reviewItems: [], summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 } },
    qualityIssues: [],
    diagnostics: {
      diagnosticsVersion: 1,
      summary: { error: 0, warning: 1, info: 0, total: 1, suggestions: 1 },
      items: [{
        id: 'diag-avoid',
        category: 'quality',
        source: 'schedule.qualityIssues',
        type: 'subject_avoid_period',
        severity: 'warning',
        targetKind: 'class',
        targetId: 'c1',
        targetName: 'G71',
        message: 'Math 排在了避开节次。',
      }],
      suggestions: [{
        id: 'sug-avoid',
        kind: 'quality',
        targetDiagnostics: ['diag-avoid'],
        targetKind: 'class',
        targetId: 'c1',
        targetName: 'G71',
        message: '检查避开节次规则后重新生成。',
      }],
    },
    score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
  };

  const state = sampleWorkbenchState({ schedule });
  const model = buildInspectorViewModel(state);
  const inspector = renderInspector(state);
  const reviewStart = inspector.indexOf('data-inspector-section="review"');
  const systemStart = inspector.indexOf('data-inspector-section="system"', reviewStart);
  const reviewMarkup = inspector.slice(reviewStart, systemStart);

  assert.equal(model.reviewItems.length, 1);
  assert.ok(model.reviewItems.some(item => item.message === 'Math 排在了避开节次。'));
  assert.doesNotMatch(reviewMarkup, /检查避开节次规则后重新生成。/);
  assert.doesNotMatch(inspectorSystemMarkup(inspector), /检查避开节次规则后重新生成。/);
  assert.doesNotMatch(inspector, /诊断建议/);
});

test('timetable inspector shows publication readiness before export', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'publish-check',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [{ lessonPlanId: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', reason: 'missing slots' }],
        publication: {
          ok: false,
          reason: 'publication_blocked',
          blockingIssues: [{ type: 'incomplete_schedule', message: '还有课时未排入课表。' }],
          reviewItems: [
            { type: 'manual_review', severity: 'warning', targetKind: 'schedule', targetName: '课表', message: '请教务复核。' },
            { type: 'teacher_load', severity: 'warning', targetKind: 'teacher', targetName: 'Math Teacher', message: 'Math Teacher 负载接近满载。' },
            { type: 'incomplete_schedule', severity: 'error', targetKind: 'class', targetName: 'G7 1', message: 'G7 1 还有 2 节未排。' },
          ],
          summary: { totalLessons: 3, placedLessons: 1, unplacedLessons: 2, hardConflicts: 0 },
        },
        score: { hardConflicts: 0, unplacedLessons: 2, placedLessons: 1, totalLessons: 3, completeness: 33 },
      },
    }),
  });

  const inspector = renderInspector(state);
  const systemMarkup = inspectorSystemMarkup(inspector);

  assert.match(systemMarkup, /发布详情/);
  assert.match(systemMarkup, /发布校验/);
  assert.match(inspector, /不可发布/);
  assert.match(inspector, /未排课时/);
  assert.match(inspector, /教务复核/);
  assert.doesNotMatch(inspector, /incomplete_schedule/);
  assert.doesNotMatch(inspector, /manual_review/);
  assert.match(inspector, /Math Teacher 负载接近满载/);
  assert.match(inspector, /G7 1 还有 2 节未排/);
  assert.doesNotMatch(systemMarkup, /发布问题/);
  assert.match(inspector, /必须先处理/);
  assert.match(inspector, /建议发布前复核/);
  assert.match(inspector, /tt-inspector-problem-group is-error/);
  assert.match(inspector, /tt-inspector-problem-group is-warning/);
  assert.match(inspector, /tt-inspector-target-row/);
  assert.match(inspector, /1\/3/);
});

test('timetable workflow exposes publish action and published status', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'publish-ready',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: {
          ok: true,
          reason: 'ready',
          blockingIssues: [],
          warnings: [],
          reviewItems: [],
          summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
        },
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      },
    }),
  });

  const html = renderWorkbench(state);

  assert.match(html, /id="tt-publish-schedule"/);
  assert.match(html, /data-publish-schedule/);
  assert.match(html, /发布课表/);
  assert.match(html, /未发布/);
  assert.doesNotMatch(html, /id="tt-publish-schedule"[^>]*disabled/);
});

test('timetable export panel exposes week-pattern views for complex schedules', async () => {
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const state = sampleWorkbenchState({
    exportWeekView: 'odd',
    project: createDefaultTimetableProject({
      timetableModelVersion: 'complex_v1',
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [], campusId: 'north' }],
      classes: [{ id: 'c1', grade: 'G7', name: '1', campusId: 'north' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1, weekPattern: 'odd', campusId: 'north' }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'complex-publish-ready',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'published',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          classIds: ['c1'],
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
          weekPattern: 'odd',
          campusId: 'north',
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: {
          ok: true,
          reason: 'ready',
          blockingIssues: [],
          warnings: [],
          reviewItems: [],
          summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
        },
        published: {
          status: 'published',
          version: 1,
          publishedAt: '2026-01-02T08:00:00.000Z',
          scheduleId: 'complex-publish-ready',
          snapshot: { scheduleId: 'complex-publish-ready', slotCount: 1, slots: [] },
        },
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      },
    }),
  });

  const html = renderWorkbench(state);

  assert.match(html, /tt-complex-model-strip/);
  assert.match(html, /复杂模型：已启用/);
  assert.match(html, /发布校验：已检查复杂冲突/);
  assert.match(html, /单双周视图：合并 \/ 单周 \/ 双周/);
  assert.match(html, /data-export-week-view="merged"/);
  assert.match(html, /data-export-week-view="odd"[^>]*is-active/);
  assert.match(html, /data-export-week-view="even"/);
  assert.match(html, /合并/);
  assert.match(html, /单周/);
  assert.match(html, /双周/);
  assert.match(interactionSource, /data-export-week-view/);
  assert.match(interactionSource, /weekView:\s*state\.exportWeekView/);
  assert.match(controllerSource, /weekView:\s*options\.weekView/);
});

test('timetable publish uses a confirmation dialog with editable note', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const closed = renderWorkbench(sampleWorkbenchState());
  const open = renderWorkbench(sampleWorkbenchState({
    publishDialog: {
      open: true,
      note: '教务主任确认',
      loading: false,
    },
  }));

  assert.match(closed, /id="tt-publish-schedule"/);
  assert.doesNotMatch(closed, /id="tt-publish-dialog"/);
  assert.match(open, /id="tt-publish-dialog"/);
  assert.match(open, /id="tt-publish-note"/);
  assert.match(open, /教务主任确认/);
  assert.match(open, /id="tt-confirm-publish"/);
  assert.match(controllerSource, /openPublishDialog\(/);
  assert.match(controllerSource, /confirmPublishSchedule\(/);
  assert.match(controllerSource, /JSON\.stringify\(\{\s*note\s*:\s*this\.state\.publishDialog\?\.note/s);
  assert.doesNotMatch(controllerSource, /JSON\.stringify\(\{\s*note:\s*''\s*\}\)/);
  assert.match(interactionSource, /#tt-publish-schedule[\s\S]*openPublishDialog\(\)/);
  assert.match(interactionSource, /#tt-confirm-publish[\s\S]*confirmPublishSchedule\(\)/);
});

test('timetable publish dialog refuses schedules that are not publication-ready', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.project = createDefaultTimetableProject({
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    schedule: {
      id: 'not-ready-publish',
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [{ lessonPlanId: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      publication: {
        ok: false,
        reason: 'publication_blocked',
        blockingIssues: [{ type: 'incomplete_schedule', message: 'unplaced lesson' }],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 2, placedLessons: 1, unplacedLessons: 1, hardConflicts: 0 },
      },
      score: { hardConflicts: 0, unplacedLessons: 1, placedLessons: 1, totalLessons: 2, completeness: 50 },
    },
  });

  controller.openPublishDialog();

  assert.deepEqual(controller.state.publishDialog, { open: false, note: '', loading: false });
  assert.ok(controller.state.message);
});

test('timetable smart workbench keeps not-ready schedules in diagnosis instead of opening publish', () => {
  const controller = new TimetablePlannerController();
  let closed = false;
  let published = false;
  controller.renderSmartWorkbenchSurface = () => {};
  controller.closeSmartWorkbench = () => { closed = true; };
  controller.openPublishDialog = () => { published = true; };
  controller.state.project = createDefaultTimetableProject({
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    schedule: {
      id: 'not-ready-smart-publish',
      source: 'fast_constructed',
      slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' }],
      conflicts: [],
      unplaced: [{ lessonPlanId: 'lp_math' }],
      publication: {
        ok: false,
        summary: { totalLessons: 2, placedLessons: 1, unplacedLessons: 1, hardConflicts: 0 },
        issues: [{ message: 'unplaced lesson' }],
      },
      score: { hardConflicts: 0, unplacedLessons: 1, placedLessons: 1, totalLessons: 2, completeness: 50 },
    },
  });
  controller.state.smartWorkbench = createConstraintDialogState({ open: true, stage: 'solution_review' });

  controller.openSmartPublish();

  assert.equal(closed, false);
  assert.equal(published, false);
  assert.equal(controller.state.smartWorkbench.open, true);
  assert.equal(controller.state.smartWorkbench.stage, 'diagnosing');
  assert.match(controller.state.smartWorkbench.diagnosis.summary, /不能保存|not/i);
});

test('timetable smart workbench sends incomplete generated schedules to diagnosis', async () => {
  const controller = new TimetablePlannerController();
  controller.renderSmartWorkbenchSurface = () => {};
  controller.render = () => {};
  controller.state.project = createDefaultTimetableProject({
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
  });
  controller.state.smartWorkbench = createConstraintDialogState({ open: true, stage: 'waiting_solve_approval' });
  controller.runSchedule = async () => {
    controller.applyProject(createDefaultTimetableProject({
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
      schedule: {
        id: 'incomplete-generated',
        source: 'fast_constructed',
        slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' }],
        conflicts: [],
        unplaced: [{ lessonPlanId: 'lp_math' }],
        publication: {
          ok: false,
          summary: { totalLessons: 2, placedLessons: 1, unplacedLessons: 1, hardConflicts: 0 },
          issues: [{ message: 'unplaced lesson' }],
        },
        score: { hardConflicts: 0, unplacedLessons: 1, placedLessons: 1, totalLessons: 2, completeness: 50 },
      },
    }));
    controller.state.lastFailure = null;
  };

  await controller.runSmartSchedule();

  assert.equal(controller.state.smartWorkbench.stage, 'diagnosing');
  assert.equal(controller.state.smartWorkbench.candidates.length, 1);
  assert.match(controller.state.smartWorkbench.diagnosis.summary, /不能保存|not/i);
});

test('timetable restore published actions use a confirmation dialog with overwrite summary', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'draft-changed',
      generatedAt: '2026-01-03T00:00:00.000Z',
      source: 'manual_adjusted',
      slots: [{
        id: 'slot-current-1',
        day: 2,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'draft_changed',
        version: 2,
        publishedAt: '2026-01-03T08:00:00.000Z',
        scheduleId: 'published-current',
        note: '第二次发布',
        fingerprint: '2222222222222222222222222222222222222222222222222222222222222222',
        snapshot: {
          scheduleId: 'published-current',
          slotCount: 1,
          fingerprint: '2222222222222222222222222222222222222222222222222222222222222222',
          score: { completeness: 100 },
          publicationSummary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
          slots: [{
            id: 'slot-published-1',
            day: 1,
            period: 1,
            classId: 'c1',
            subjectId: 'math',
            teacherId: 't_math',
            teacherIds: ['t_math'],
            lessonPlanId: 'lp_math',
          }],
        },
        history: [{
          version: 1,
          publishedAt: '2026-01-01T08:00:00.000Z',
          scheduleId: 'published-v1',
          note: '第一次发布',
          fingerprint: '1111111111111111111111111111111111111111111111111111111111111111',
          snapshot: {
            scheduleId: 'published-v1',
            slotCount: 1,
            fingerprint: '1111111111111111111111111111111111111111111111111111111111111111',
            score: { completeness: 100 },
            publicationSummary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
            slots: [{
              id: 'slot-v1-1',
              day: 1,
              period: 1,
              classId: 'c1',
              subjectId: 'math',
              teacherId: 't_math',
              teacherIds: ['t_math'],
              lessonPlanId: 'lp_math',
            }],
          },
        }],
      },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
  });

  const closed = renderWorkbench(sampleWorkbenchState({ project }));
  const open = renderWorkbench(sampleWorkbenchState({
    project,
    restoreDialog: {
      open: true,
      mode: 'latest',
      version: 2,
      loading: false,
      targetLabel: '发布版 V2',
      summary: { moved: 1, changed: 0, added: 0, removed: 0, total: 1 },
    },
  }));

  assert.doesNotMatch(closed, /id="tt-restore-dialog"/);
  assert.match(open, /id="tt-restore-dialog"/);
  assert.match(open, /恢复发布版/);
  assert.match(open, /发布版 V2/);
  assert.match(open, /当前草稿将被覆盖/);
  assert.match(open, /<b>移动<\/b>1/);
  assert.match(open, /id="tt-confirm-restore"/);
  assert.match(controllerSource, /openRestoreDialog\(/);
  assert.match(controllerSource, /confirmRestoreSchedule\(/);
  assert.match(controllerSource, /restorePublicationHistoryVersion\([^)]*\)\s*\{/);
  assert.match(controllerSource, /restoreLatestPublishedSnapshot\(\)\s*\{/);
  assert.doesNotMatch(controllerSource, /requestTimetable\('\/schedule\/published\/restore'[\s\S]*restorePublicationHistoryVersion\(/);
  assert.match(interactionSource, /#tt-restore-publication-history[\s\S]*openRestoreDialog/);
  assert.match(interactionSource, /\[data-restore-published-snapshot\][\s\S]*openRestoreDialog\('latest', button\.dataset\.restorePublishedVersion\)/);
  assert.match(interactionSource, /#tt-confirm-restore[\s\S]*confirmRestoreSchedule/);
});

test('timetable publish confirmation surfaces review warnings before publishing', () => {
  const open = renderWorkbench(sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'publish-with-warnings',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: {
          ok: true,
          reason: 'ready',
          blockingIssues: [],
          warnings: [{
            type: 'publication_fingerprint_mismatch',
            targetName: '发布历史 V1',
            message: '发布快照校验失败，请重新发布后再导出或恢复。',
          }],
          reviewItems: [{
            type: 'teacher_load',
            severity: 'warning',
            targetKind: 'teacher',
            targetName: 'Math Teacher',
            message: 'Math Teacher 负载接近满载。',
          }],
          summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
        },
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      },
    }),
    publishDialog: {
      open: true,
      note: '',
      loading: false,
    },
  }));

  assert.match(open, /id="tt-publish-dialog"/);
  assert.match(open, /发布提醒/);
  assert.match(open, /发布历史 V1/);
  assert.match(open, /发布快照校验失败/);
  assert.match(open, /Math Teacher/);
  assert.match(open, /负载接近满载/);
  assert.doesNotMatch(open, /publication_fingerprint_mismatch/);
  assert.doesNotMatch(open, /teacher_load/);
});

test('timetable publish confirmation surfaces published snapshot backfill warning in human text', () => {
  const open = renderWorkbench(sampleWorkbenchState({
    schedule: {
      id: 'publish-with-backfill-warning',
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'published',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [{
          type: 'published_snapshot_backfill_needed',
          targetName: '发布快照',
          message: '当前已发布版本缺少发布快照，系统会在导出、恢复或重新发布前自动补修。',
        }],
        reviewItems: [{
          type: 'published_snapshot_backfill_needed',
          severity: 'warning',
          targetKind: 'schedule',
          targetName: '发布快照',
          message: '当前已发布版本缺少发布快照，系统会在导出、恢复或重新发布前自动补修。',
        }],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'published',
        version: 1,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'publish-with-backfill-warning',
        note: 'legacy publish',
      },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
    publishDialog: {
      open: true,
      note: '',
      loading: false,
    },
  }));

  assert.match(open, /id="tt-publish-dialog"/);
  assert.match(open, /发布快照/);
  assert.match(open, /自动补修/);
  assert.doesNotMatch(open, /published_snapshot_backfill_needed/);
});

test('timetable workflow disables official exports when published draft changed', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'draft-changed',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual_adjusted',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: {
          ok: true,
          reason: 'ready',
          blockingIssues: [],
          warnings: [],
          reviewItems: [],
          summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
        },
        published: {
          status: 'draft_changed',
          version: 1,
          publishedAt: '2026-01-02T08:00:00.000Z',
          scheduleId: 'published-1',
          note: '教务处确认发布',
          snapshot: {
            scheduleId: 'published-1',
            slotCount: 1,
            score: { completeness: 100 },
            slots: [{
              id: 'slot-1',
              day: 1,
              period: 1,
              classId: 'c1',
              subjectId: 'math',
              teacherId: 't_math',
              teacherIds: ['t_math'],
              lessonPlanId: 'lp_math',
            }],
          },
        },
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      },
    }),
  });

  const html = renderWorkbench(state);

  assert.match(html, /草稿已变化/);
  assert.match(html, /请重新发布后导出正式课表/);
  assert.match(html, /data-export-type="class"[^>]*disabled/);
  assert.match(html, /data-export-type="teacher"[^>]*disabled/);
  assert.match(html, /data-export-type="master"[^>]*disabled/);
  assert.match(html, /导出发布版/);
  assert.match(html, /data-export-type="published_class"/);
  assert.match(html, /data-export-type="published_teacher"/);
  assert.match(html, /data-export-type="published_master"/);
  assert.doesNotMatch(html, /data-export-type="plans"[^>]*disabled/);
});

test('timetable workflow explains missing published snapshot when a changed draft cannot restore the published version', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'draft-changed-missing-published-snapshot',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual_adjusted',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: {
          ok: true,
          reason: 'ready',
          blockingIssues: [],
          warnings: [{
            type: 'published_snapshot_missing',
            targetName: '发布快照',
            message: '上一版发布快照缺失，当前只能重新发布，暂时无法恢复或导出发布版。',
          }],
          reviewItems: [{
            type: 'published_snapshot_missing',
            severity: 'warning',
            targetKind: 'schedule',
            targetName: '发布快照',
            message: '上一版发布快照缺失，当前只能重新发布，暂时无法恢复或导出发布版。',
          }],
          summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
        },
        published: {
          status: 'draft_changed',
          version: 1,
          publishedAt: '2026-01-02T08:00:00.000Z',
          scheduleId: 'published-1',
          note: '教务处确认发布',
        },
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      },
    }),
  });

  const html = renderWorkbench(state);
  const inspector = renderInspector(state);

  assert.match(html, /草稿已变化/);
  assert.doesNotMatch(html, /data-export-type="published_class"/);
  assert.doesNotMatch(html, /id="tt-restore-published-snapshot"/);
  assert.match(html, /上一版发布快照缺失/);
  assert.match(inspector, /发布快照/);
  assert.match(inspector, /暂时无法恢复或导出发布版/);
  assert.doesNotMatch(html, /published_snapshot_missing/);
});

test('timetable workflow keeps published restore/export entry when current draft was cleared but archive remains', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [],
      classes: [],
      subjects: [],
      lessonPlans: [],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'archive-only-draft',
        generatedAt: '2026-01-03T00:00:00.000Z',
        source: 'published',
        slots: [],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: null,
        published: {
          status: 'draft_changed',
          version: 3,
          publishedAt: '2026-01-02T08:00:00.000Z',
          scheduleId: 'published-3',
          note: '教务处确认发布',
          snapshot: {
            scheduleId: 'published-3',
            slotCount: 1,
            score: { completeness: 100 },
            publicationSummary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
            projectContext: {
              schoolName: 'UI School',
              term: '2026',
              weekdays: 5,
              periodsPerDay: 7,
              activeWeekdays: [1, 2, 3, 4, 5],
              activePeriods: [1, 2, 3, 4, 5, 6, 7],
              teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
              classes: [{ id: 'c1', grade: 'G7', name: '1' }],
              subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
              lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
              rules: { hardRules: {}, softRules: {} },
            },
            slots: [{
              id: 'slot-1',
              day: 1,
              period: 1,
              classId: 'c1',
              subjectId: 'math',
              teacherId: 't_math',
              teacherIds: ['t_math'],
              lessonPlanId: 'lp_math',
            }],
          },
        },
        score: {},
      },
    }),
  });

  const html = renderWorkbench(state);
  const inspector = renderInspector(state);

  assert.match(html, /当前工作草稿已清空，仍可恢复或导出已发布版本。/);
  assert.match(html, /data-restore-published-snapshot="latest"/);
  assert.match(html, /data-export-type="published_class"/);
  assert.match(html, /data-export-type="published_teacher"/);
  assert.match(html, /data-export-type="published_master"/);
  assert.match(html, /当前草稿已清空/);
  assert.match(inspector, /发布归档/);
  assert.match(inspector, /已清空，仍可恢复或导出已发布版本/);
});

test('timetable archive-only draft does not fall back to roster-import readiness copy', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [],
      classes: [],
      subjects: [],
      lessonPlans: [],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'archive-only-topbar',
        generatedAt: '2026-01-03T00:00:00.000Z',
        source: 'published',
        slots: [],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: null,
        published: {
          status: 'draft_changed',
          version: 3,
          publishedAt: '2026-01-02T08:00:00.000Z',
          scheduleId: 'published-3',
          snapshot: {
            scheduleId: 'published-3',
            slotCount: 1,
            score: { completeness: 100 },
            publicationSummary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
            projectContext: {
              schoolName: 'UI School',
              term: '2026',
              weekdays: 5,
              periodsPerDay: 7,
              activeWeekdays: [1, 2, 3, 4, 5],
              activePeriods: [1, 2, 3, 4, 5, 6, 7],
              teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
              classes: [{ id: 'c1', grade: 'G7', name: '1' }],
              subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
              lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
              rules: { hardRules: {}, softRules: {} },
            },
            slots: [{
              id: 'slot-1',
              day: 1,
              period: 1,
              classId: 'c1',
              subjectId: 'math',
              teacherId: 't_math',
              teacherIds: ['t_math'],
              lessonPlanId: 'lp_math',
            }],
          },
        },
        score: {},
      },
    }),
  });

  const html = renderWorkbench(state);

  assert.match(html, /来源<\/span><strong>草稿已变化<\/strong>/);
  assert.match(html, /data-restore-published-snapshot="latest"/);
  assert.doesNotMatch(html, /待导入任课/);
  assert.doesNotMatch(html, /请先导入任课数据。/);
});

test('timetable workflow treats published status with slot drift as draft changed', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'published-drift',
      generatedAt: '2026-01-03T00:00:00.000Z',
      source: 'published',
      slots: [{
        id: 'slot-1',
        day: 2,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'published',
        version: 1,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-1',
        note: '教务处确认发布',
        snapshot: {
          scheduleId: 'published-1',
          slotCount: 1,
          score: { completeness: 100 },
          slots: [{
            id: 'slot-1',
            day: 1,
            period: 1,
            classId: 'c1',
            subjectId: 'math',
            teacherId: 't_math',
            teacherIds: ['t_math'],
            lessonPlanId: 'lp_math',
          }],
        },
      },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
  });
  const html = renderWorkbench(sampleWorkbenchState({ project }));
  const status = getSolveStatus(project);

  assert.equal(status.sourceLabel, '草稿已变化');
  assert.match(html, /草稿已变化/);
  assert.doesNotMatch(html, /<span>来源<\/span><strong>已发布<\/strong>/);
  assert.match(html, /<span>来源<\/span><strong>草稿已变化<\/strong>/);
  assert.match(html, /发布差异/);
  assert.match(html, /请重新发布后导出正式课表/);
  assert.match(buttonTag(html, 'data-export-type="class"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-type="teacher"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-type="master"'), /disabled/);
});

test('timetable workflow disables official exports until the schedule is published', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'ready-unpublished',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: null,
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
  });
  const html = renderWorkbench(sampleWorkbenchState({ project }));

  assert.match(html, /请先发布课表后导出正式课表/);
  assert.match(buttonTag(html, 'data-export-type="class"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-type="teacher"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-type="master"'), /disabled/);
  assert.doesNotMatch(buttonTag(html, 'data-export-type="plans"'), /disabled/);
});

test('timetable workflow disables published snapshot export and restore when fingerprint is known bad', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'bad-published-snapshot',
        generatedAt: '2026-01-03T00:00:00.000Z',
        source: 'manual_adjusted',
        slots: [{
          id: 'slot-1',
          day: 2,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: {
          ok: true,
          reason: 'ready',
          blockingIssues: [],
          warnings: [{
            type: 'publication_fingerprint_mismatch',
            targetName: '发布快照',
            message: '发布快照校验失败，请重新发布后再导出或恢复。',
          }],
          reviewItems: [{
            type: 'publication_fingerprint_mismatch',
            severity: 'warning',
            targetKind: 'schedule',
            targetName: '发布快照',
            message: '发布快照校验失败，请重新发布后再导出或恢复。',
          }],
          summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
        },
        published: {
          status: 'draft_changed',
          version: 1,
          publishedAt: '2026-01-02T08:00:00.000Z',
          scheduleId: 'published-1',
          note: '教务处确认发布',
          fingerprint: 'badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb',
          snapshot: {
            scheduleId: 'published-1',
            slotCount: 1,
            fingerprint: 'badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb',
            score: { completeness: 100 },
            slots: [{
              id: 'slot-1',
              day: 1,
              period: 1,
              classId: 'c1',
              subjectId: 'math',
              teacherId: 't_math',
              teacherIds: ['t_math'],
              lessonPlanId: 'lp_math',
            }],
          },
        },
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      },
    }),
  });

  const html = renderWorkbench(state);

  assert.match(buttonTag(html, 'data-export-type="published_class"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-type="published_teacher"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-type="published_master"'), /disabled/);
  assert.match(buttonTag(html, 'data-restore-published-snapshot="latest"'), /disabled/);
  assert.match(html, /发布快照校验失败，请重新发布后再导出或恢复。/);
  assert.match(buttonTag(html, 'id="tt-publish-schedule"'), /data-publish-schedule/);
  assert.doesNotMatch(buttonTag(html, 'id="tt-publish-schedule"'), /disabled/);
  assert.doesNotMatch(html, /publication_fingerprint_mismatch/);
});

test('timetable inspector explains published and changed draft states', () => {
  const publishedProject = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'published-1',
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'published',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'published',
        version: 1,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-1',
        note: '教务处确认发布',
        fingerprint: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        snapshot: {
          scheduleId: 'published-1',
          generatedAt: '2026-01-01T00:00:00.000Z',
          source: 'fast_constructed',
          slotCount: 12,
          fingerprint: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          score: { completeness: 100 },
          publicationSummary: { totalLessons: 12, placedLessons: 12, unplacedLessons: 0, hardConflicts: 0 },
          slots: [],
        },
        history: [{
          version: 1,
          publishedAt: '2026-01-01T08:00:00.000Z',
          scheduleId: 'published-0',
          note: '第一次发布',
          fingerprint: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          snapshot: {
            scheduleId: 'published-0',
            slotCount: 10,
            fingerprint: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            score: { completeness: 100 },
            publicationSummary: { totalLessons: 10, placedLessons: 10, unplacedLessons: 0, hardConflicts: 0 },
            slots: [],
          },
        }],
      },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
  });

  const publishedInspector = renderInspector(sampleWorkbenchState({ project: publishedProject }));
  const changedInspector = renderInspector(sampleWorkbenchState({
    project: {
      ...publishedProject,
      schedule: {
        ...publishedProject.schedule,
        published: {
          ...publishedProject.schedule.published,
          status: 'draft_changed',
        },
      },
    },
  }));
  const restoredInspector = renderInspector(sampleWorkbenchState({
    project: {
      ...publishedProject,
      schedule: {
        ...publishedProject.schedule,
        source: 'published_history_restored',
        publication: {
          ...publishedProject.schedule.publication,
          warnings: [{
            type: 'restored_published_draft',
            message: '当前草稿来自恢复发布版，重新发布前建议教务复核。',
          }],
          reviewItems: [{
            type: 'restored_published_draft',
            severity: 'warning',
            targetKind: 'schedule',
            targetName: '恢复发布版',
            message: '当前草稿来自恢复发布版，重新发布前建议教务复核。',
          }],
          summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
        },
        published: {
          ...publishedProject.schedule.published,
          status: 'draft_changed',
        },
      },
    },
  }));

  const publishedSystemMarkup = inspectorSystemMarkup(publishedInspector);
  const changedSystemMarkup = inspectorSystemMarkup(changedInspector);

  assert.match(publishedSystemMarkup, /发布详情/);
  assert.match(publishedSystemMarkup, /发布状态/);
  assert.match(publishedInspector, /已发布/);
  assert.match(publishedInspector, /已发布 V1/);
  assert.match(publishedInspector, /来源<\/b>已发布/);
  assert.match(publishedInspector, /发布指纹/);
  assert.match(publishedInspector, /1234567890ab/);
  assert.doesNotMatch(publishedSystemMarkup, /发布历史/);
  assert.doesNotMatch(publishedSystemMarkup, /教务处确认发布/);
  assert.match(changedInspector, /草稿已变化/);
  assert.match(changedInspector, /发布归档/);
  assert.match(changedInspector, /当前工作草稿已清空/);
  assert.match(changedSystemMarkup, /发布状态<\/b>草稿已变化/);
  assert.match(restoredInspector, /恢复发布版/);
  assert.match(restoredInspector, /重新发布前建议教务复核/);
  assert.doesNotMatch(restoredInspector, /restored_published_draft/);

  const republishedInspector = renderInspector(sampleWorkbenchState({
    project: {
      ...publishedProject,
      schedule: {
        ...publishedProject.schedule,
        source: 'published',
        publication: {
          ...publishedProject.schedule.publication,
          warnings: [],
          reviewItems: [],
        },
        published: {
          ...publishedProject.schedule.published,
          status: 'published',
        },
        solverStats: {
          phase: 'published',
          status: 'accepted',
          accepted: true,
          reason: null,
          restoredPublishedDraft: true,
          restoredVersion: 1,
          restoredScheduleId: 'published-1',
        },
      },
    },
  }));
  const republishedStatus = getSolveStatus({
    ...publishedProject,
    schedule: {
      ...publishedProject.schedule,
      source: 'published',
      published: {
        ...publishedProject.schedule.published,
        status: 'published',
      },
      solverStats: {
        phase: 'published',
        status: 'accepted',
        accepted: true,
        reason: null,
        restoredPublishedDraft: true,
        restoredVersion: 1,
        restoredScheduleId: 'published-1',
      },
    },
  });

  assert.equal(republishedStatus.sourceLabel, '已发布');
  assert.match(republishedInspector, /<b>来源<\/b>已发布/);
  assert.doesNotMatch(republishedInspector, /恢复发布版/);

  const fingerprintFailedInspector = renderInspector(sampleWorkbenchState({
    project: {
      ...publishedProject,
      schedule: {
        ...publishedProject.schedule,
        publication: {
          ...publishedProject.schedule.publication,
          ok: true,
          reason: 'ready',
          warnings: [{
            type: 'publication_fingerprint_mismatch',
            targetName: '发布快照',
            message: '发布快照校验失败，请重新发布后再导出或恢复。',
          }],
          reviewItems: [{
            type: 'publication_fingerprint_mismatch',
            severity: 'warning',
            targetKind: 'schedule',
            targetName: '发布快照',
            message: '发布快照校验失败，请重新发布后再导出或恢复。',
          }],
          summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
        },
      },
    },
  }));
  assert.match(fingerprintFailedInspector, /发布快照校验/);
  assert.match(fingerprintFailedInspector, /重新发布后再导出或恢复/);
  assert.doesNotMatch(fingerprintFailedInspector, /publication_fingerprint_mismatch/);
});

test('timetable publication history opens a detail dialog for snapshot review', async () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'published-current',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'published',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-current',
        note: '第二次发布',
        fingerprint: '2222222222222222222222222222222222222222222222222222222222222222',
        snapshot: { scheduleId: 'published-current', slotCount: 2, fingerprint: '2222222222222222222222222222222222222222222222222222222222222222', slots: [] },
        history: [{
          version: 1,
          publishedAt: '2026-01-01T08:00:00.000Z',
          scheduleId: 'published-v1',
          note: '第一次发布',
          fingerprint: '1111111111111111111111111111111111111111111111111111111111111111',
          snapshot: {
            scheduleId: 'published-v1',
            slotCount: 2,
            fingerprint: '1111111111111111111111111111111111111111111111111111111111111111',
            score: { completeness: 100 },
            publicationSummary: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0 },
            slots: [
              {
                id: 'slot-v1-1',
                day: 1,
                period: 1,
                classId: 'c1',
                subjectId: 'math',
                teacherId: 't_math',
                teacherIds: ['t_math'],
                lessonPlanId: 'lp_math',
              },
            ],
          },
        }],
      },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 2, totalLessons: 2, completeness: 100 },
    },
  });
  const state = sampleWorkbenchState({
    project,
    publicationHistoryDialog: { open: true, version: 1 },
  });
  const html = renderWorkbench(state);
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');

  assert.match(html, /id="tt-publication-history-dialog"/);
  assert.match(html, /V1/);
  assert.match(html, /published-v1/);
  assert.match(html, /发布指纹/);
  assert.match(html, /111111111111/);
  assert.match(html, /Math Teacher/);
  assert.match(html, /1-1/);
  assert.match(html, /id="tt-restore-publication-history"/);
  assert.match(html, /data-export-history-type="published_class"/);
  assert.match(html, /data-export-history-type="published_teacher"/);
  assert.match(html, /data-export-history-type="published_master"/);
  assert.match(controllerSource, /openPublicationHistoryDialog\(/);
  assert.match(controllerSource, /closePublicationHistoryDialog\(/);
  assert.match(controllerSource, /restorePublicationHistoryVersion\(/);
  assert.match(controllerSource, /openRestoreDialog\(/);
  assert.match(controllerSource, /confirmRestoreSchedule\(/);
  assert.match(controllerSource, /publishedVersion/);
  assert.match(controllerSource, /requestTimetable\('\/schedule\/published\/restore'/);
  assert.match(interactionSource, /data-publication-history-version[\s\S]*openPublicationHistoryDialog/);
  assert.match(interactionSource, /#tt-restore-publication-history[\s\S]*openRestoreDialog/);
  assert.match(interactionSource, /data-export-history-type[\s\S]*export\(button\.dataset\.exportHistoryType/);
  assert.match(interactionSource, /#tt-close-publication-history[\s\S]*closePublicationHistoryDialog/);
});

test('timetable publication history disables export and restore when history fingerprint is known bad', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'published-current',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [{
          type: 'publication_fingerprint_mismatch',
          targetName: '发布历史 V1',
          message: '发布快照校验失败，请重新发布后再导出或恢复。',
        }],
        reviewItems: [{
          type: 'publication_fingerprint_mismatch',
          severity: 'warning',
          targetKind: 'schedule',
          targetName: '发布历史 V1',
          message: '发布快照校验失败，请重新发布后再导出或恢复。',
        }],
        summary: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'published',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-current',
        note: '第二次发布',
        fingerprint: '2222222222222222222222222222222222222222222222222222222222222222',
        snapshot: {
          scheduleId: 'published-current',
          slotCount: 2,
          fingerprint: '2222222222222222222222222222222222222222222222222222222222222222',
          slots: [],
        },
        history: [{
          version: 1,
          publishedAt: '2026-01-01T08:00:00.000Z',
          scheduleId: 'published-v1',
          note: '第一次发布',
          fingerprint: '1111111111111111111111111111111111111111111111111111111111111111',
          snapshot: {
            scheduleId: 'published-v1',
            slotCount: 2,
            fingerprint: '1111111111111111111111111111111111111111111111111111111111111111',
            score: { completeness: 100 },
            publicationSummary: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0 },
            slots: [],
          },
        }],
      },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 2, totalLessons: 2, completeness: 100 },
    },
  });
  const html = renderWorkbench(sampleWorkbenchState({
    project,
    publicationHistoryDialog: { open: true, version: 1 },
  }));

  assert.match(buttonTag(html, 'data-export-history-type="published_class"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-history-type="published_teacher"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-history-type="published_master"'), /disabled/);
  assert.match(buttonTag(html, 'id="tt-restore-publication-history"'), /disabled/);
  assert.match(html, /发布历史 V1/);
  assert.match(html, /发布快照校验失败，请重新发布后再导出或恢复。/);
  assert.doesNotMatch(html, /publication_fingerprint_mismatch/);
});

test('timetable export panel disables official export when current published fingerprint is known bad', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'published-current',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [{
          type: 'publication_fingerprint_mismatch',
          targetName: '发布快照',
          message: '发布快照校验失败，请重新发布后再导出或恢复。',
        }],
        reviewItems: [{
          type: 'publication_fingerprint_mismatch',
          severity: 'warning',
          targetKind: 'schedule',
          targetName: '发布快照',
          message: '发布快照校验失败，请重新发布后再导出或恢复。',
        }],
        summary: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'published',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-current',
        note: '第二次发布',
        fingerprint: '0'.repeat(64),
        snapshot: {
          scheduleId: 'published-current',
          slotCount: 2,
          fingerprint: '0'.repeat(64),
          slots: [],
        },
        history: [],
      },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 2, totalLessons: 2, completeness: 100 },
    },
  });
  const html = renderWorkbench(sampleWorkbenchState({ project }));

  assert.match(buttonTag(html, 'data-export-type="class"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-type="teacher"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-type="master"'), /disabled/);
  assert.doesNotMatch(buttonTag(html, 'data-export-type="plans"'), /disabled/);
  assert.match(html, /发布快照校验失败，请重新发布后再导出或恢复。/);
  assert.doesNotMatch(html, /publication_fingerprint_mismatch/);
});

test('timetable inspector compares current draft against the published snapshot', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'draft-after-publish',
      generatedAt: '2026-01-03T00:00:00.000Z',
      source: 'manual_adjusted',
      slots: [
        {
          id: 'slot-moved',
          day: 2,
          period: 3,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        },
        {
          id: 'slot-added',
          day: 3,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        },
      ],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'draft_changed',
        version: 1,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-1',
        note: '教务处确认发布',
        snapshot: {
          scheduleId: 'published-1',
          generatedAt: '2026-01-01T00:00:00.000Z',
          source: 'fast_constructed',
          slotCount: 2,
          score: { completeness: 100 },
          publicationSummary: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0 },
          slots: [
            {
              id: 'slot-moved',
              day: 1,
              period: 1,
              classId: 'c1',
              subjectId: 'math',
              teacherId: 't_math',
              teacherIds: ['t_math'],
              lessonPlanId: 'lp_math',
            },
            {
              id: 'slot-removed',
              day: 1,
              period: 2,
              classId: 'c1',
              subjectId: 'math',
              teacherId: 't_math',
              teacherIds: ['t_math'],
              lessonPlanId: 'lp_math',
            },
          ],
        },
      },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 2, totalLessons: 2, completeness: 100 },
    },
  });

  const diff = getPublishedScheduleDiff(project);
  const inspector = renderInspector(sampleWorkbenchState({ project }));

  assert.equal(diff.total, 3);
  assert.equal(diff.moved, 1);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.match(inspector, /发布差异/);
  assert.match(inspector, /移动 1/);
  assert.match(inspector, /新增 1/);
  assert.match(inspector, /移除 1/);
  assert.match(inspector, /请重新发布后导出正式课表/);
  assert.doesNotMatch(inspectorSystemMarkup(inspector), /id="tt-restore-published-snapshot"/);
  assert.doesNotMatch(inspectorSystemMarkup(inspector), /周一 第1节/);
});

test('timetable archive-only draft uses published snapshot context for diff labels and restore wiring', async () => {
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [],
    classes: [],
    subjects: [],
    lessonPlans: [],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'archive-only-context',
      generatedAt: '2026-01-03T00:00:00.000Z',
      source: 'published',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: null,
      published: {
        status: 'draft_changed',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-2',
        note: '教务处确认发布',
        snapshot: {
          scheduleId: 'published-2',
          slotCount: 1,
          score: { completeness: 100 },
          publicationSummary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
          projectContext: {
            schoolName: 'UI School',
            term: '2026',
            weekdays: 5,
            periodsPerDay: 7,
            activeWeekdays: [1, 2, 3, 4, 5],
            activePeriods: [1, 2, 3, 4, 5, 6, 7],
            teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
            classes: [{ id: 'c1', grade: 'G7', name: '1' }],
            subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
            lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
            rules: { hardRules: {}, softRules: {} },
          },
          slots: [{
            id: 'slot-1',
            day: 1,
            period: 1,
            classId: 'c1',
            subjectId: 'math',
            teacherId: 't_math',
            teacherIds: ['t_math'],
            lessonPlanId: 'lp_math',
          }],
        },
      },
      score: {},
    },
  });

  const html = renderWorkbench(sampleWorkbenchState({ project }));

  assert.match(html, /data-restore-published-snapshot="latest"/);
  assert.match(html, /data-restore-published-version="2"/);
  assert.match(html, /data-export-type="published_class"/);
  assert.match(interactionSource, /\[data-restore-published-snapshot\][\s\S]*openRestoreDialog\('latest', button\.dataset\.restorePublishedVersion\)/);
});

test('timetable publish action is wired through controller and grid interactions', async () => {
  const manualProject = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'manual-current',
      generatedAt: '2026-01-03T00:00:00.000Z',
      source: 'manual_adjusted',
      slots: [{
        id: 'slot-1',
        day: 2,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        manuallyAdjusted: true,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      solverStats: {
        phase: 'manual_adjustment',
        status: 'accepted',
        accepted: true,
        reason: null,
      },
    },
  });
  const manualInspector = renderInspector(sampleWorkbenchState({ project: manualProject }));

  assert.match(manualInspector, /<b>来源<\/b>手动调整/);
  assert.doesNotMatch(manualInspector, /Timefold 未完成/);
  assert.doesNotMatch(manualInspector, /后台优化超时/);
  assert.doesNotMatch(manualInspector, /优化原因/);
  assert.doesNotMatch(manualInspector, /优化处理/);

  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');

  assert.match(controllerSource, /async\s+publishSchedule\(/);
  assert.match(controllerSource, /requestTimetable\('\/schedule\/publish'/);
  assert.match(interactionSource, /#tt-publish-schedule/);
  assert.match(interactionSource, /openPublishDialog\(\)/);
  assert.match(interactionSource, /#tt-confirm-publish/);
  assert.match(interactionSource, /confirmPublishSchedule\(\)/);
  assert.match(interactionSource, /\[data-restore-published-snapshot\]/);
  assert.match(interactionSource, /openRestoreDialog\('latest', button\.dataset\.restorePublishedVersion\)/);
});

test('timetable inspector treats manual adjustment review as school review instead of optimization fallback', () => {
  const reviewProject = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'manual-review',
      generatedAt: '2026-01-03T00:00:00.000Z',
      source: 'manual_adjusted',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        manuallyAdjusted: true,
      }],
      lockedSlots: [],
      conflicts: [{
        type: 'unplaced',
        severity: 'hard',
        message: '仍有课时未进入课表',
        lessonPlanId: 'lp_math',
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
      }],
      unplaced: [{
        lessonPlanId: 'lp_math',
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        reason: 'Manual review still required',
      }],
      score: { hardConflicts: 1, unplacedLessons: 1, placedLessons: 1, totalLessons: 2, completeness: 50 },
      solverStats: {
        phase: 'manual_adjustment',
        status: 'needs_review',
        accepted: false,
        reason: 'manual_adjustment_conflicts',
      },
    },
  });

  const inspector = renderInspector(sampleWorkbenchState({ project: reviewProject }));

  assert.match(inspector, /<b>来源<\/b>手动调整/);
  assert.match(inspector, /手动调整/);
  assert.match(inspector, /教务复核/);
  assert.doesNotMatch(inspector, /优化原因/);
  assert.doesNotMatch(inspector, /优化处理/);
  assert.doesNotMatch(inspector, /后台优化未采纳/);
});

test('timetable inspector treats stale optimization on manual schedules as optimization status, not manual review', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'manual-stale-optimization',
      generatedAt: '2026-01-03T00:00:00.000Z',
      source: 'manual_adjusted',
      slots: [{
        id: 'slot-1',
        day: 2,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        manuallyAdjusted: true,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      solverStats: {
        phase: 'manual_adjustment',
        status: 'accepted',
        accepted: true,
        reason: null,
      },
    },
  });

  const inspector = renderInspector(sampleWorkbenchState({
    project,
    solverJob: {
      jobId: 'stale-manual-job',
      phase: 'timefold_optimization',
      status: 'failed',
      accepted: false,
      reason: 'stale_schedule',
    },
  }));

  assert.match(inspector, /优化原因/);
  assert.match(inspector, /课表已被更新，旧优化结果已作废/);
  assert.match(inspector, /优化处理/);
  assert.doesNotMatch(inspector, /<b>教务复核<\/b>课表已被更新，旧优化结果已作废/);
});

test('timetable restored published schedules are labeled as restored publish versions', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'restored-published-1',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published_history_restored',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        locked: false,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      solverStats: { phase: 'published_history_restore', status: 'restored' },
    },
  });

  const status = getSolveStatus(project);
  const inspector = renderInspector(sampleWorkbenchState({ project }));

  assert.equal(status.sourceLabel, '\u6062\u590d\u53d1\u5e03\u7248');
  assert.match(inspector, /\u6062\u590d\u53d1\u5e03\u7248/);
  assert.doesNotMatch(inspector, /\u672a\u751f\u6210/);
});

test('timetable optimization panel labels restored published drafts correctly', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'restored-published-optimization',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published_history_restored',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        locked: false,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      solverStats: { phase: 'published_history_restore', status: 'restored' },
    },
  });
  const inspector = renderInspector(sampleWorkbenchState({
    project,
    solverJob: {
      jobId: 'old-job',
      phase: 'timefold_optimization',
      status: 'failed',
      accepted: false,
      reason: 'stale_schedule',
    },
  }));

  assert.match(inspector, /<b>当前课表<\/b>恢复发布版/);
  assert.doesNotMatch(inspector, /<b>当前课表<\/b>未生成/);
});

test('timetable optimization panel keeps restored-published label after manual adjustment on a restored draft', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'restored-manual-optimization',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'manual_adjusted',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        locked: false,
        manuallyAdjusted: true,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      solverStats: {
        phase: 'manual_adjustment',
        status: 'accepted',
        accepted: true,
        reason: null,
        restoredPublishedDraft: true,
        restoredVersion: 2,
        restoredScheduleId: 'published-v2',
      },
    },
  });
  const inspector = renderInspector(sampleWorkbenchState({
    project,
    solverJob: {
      jobId: 'manual-restored-job',
      phase: 'timefold_optimization',
      status: 'failed',
      accepted: false,
      reason: 'stale_schedule',
    },
  }));

  assert.match(inspector, /<b>当前课表<\/b>恢复发布版/);
  assert.doesNotMatch(inspector, /<b>当前课表<\/b>手动调整/);
});

test('timetable published schedules do not keep showing the background optimization panel from stale solver stats', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'published-with-stale-opt-stats',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        locked: false,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'published',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-v2',
        note: '教务处确认发布',
      },
      solverStats: {
        phase: 'timefold_optimization',
        status: 'completed',
        accepted: false,
        reason: 'not_better',
        initialSolutionUsed: true,
        pinnedCount: 2,
      },
    },
  });

  const inspector = renderInspector(sampleWorkbenchState({ project }));

  assert.doesNotMatch(inspector, /后台优化/);
  assert.doesNotMatch(inspector, /优化原因/);
  assert.doesNotMatch(inspector, /优化处理/);
  assert.doesNotMatch(inspector, /初始解/);
  assert.doesNotMatch(inspector, /锁定课节/);
});

test('timetable inspector keeps restored-published review wording after accepted optimization on a restored draft', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'restored-optimized-1',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'timefold_solver',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        locked: false,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [{
          type: 'restored_published_draft',
          message: '当前草稿来自恢复发布版，重新发布前建议教务复核。',
        }],
        reviewItems: [{
          type: 'restored_published_draft',
          severity: 'warning',
          targetKind: 'schedule',
          targetName: '恢复发布版',
          message: '当前草稿来自恢复发布版，重新发布前建议教务复核。',
        }],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'draft_changed',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-v2',
        note: '恢复的发布版',
      },
      solverStats: {
        phase: 'timefold_optimization',
        status: 'completed',
        accepted: true,
        reason: null,
        restoredPublishedDraft: true,
        restoredVersion: 2,
        restoredScheduleId: 'published-v2',
      },
    },
  });

  const inspector = renderInspector(sampleWorkbenchState({ project }));

  assert.match(inspector, /恢复发布版/);
  assert.match(inspector, /重新发布前建议教务复核/);
});

test('timetable topbar keeps restored-published source wording after accepted optimization on a restored draft', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'restored-topbar-1',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'timefold_solver',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        locked: false,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [{
          type: 'restored_published_draft',
          message: '当前草稿来自恢复发布版，重新发布前建议教务复核。',
        }],
        reviewItems: [],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'draft_changed',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-v2',
        note: '恢复的发布版',
      },
      solverStats: {
        phase: 'timefold_optimization',
        status: 'completed',
        accepted: true,
        reason: null,
        restoredPublishedDraft: true,
        restoredVersion: 2,
        restoredScheduleId: 'published-v2',
      },
    },
  });

  const status = getSolveStatus(project);
  const panel = renderSchedulePanel(sampleWorkbenchState({ project }));

  assert.equal(status.sourceLabel, '恢复发布版');
  assert.match(panel, /可生成/);
});

test('timetable manual-adjusted restored drafts keep restored-published wording and review warning', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'restored-manual-1',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'manual_adjusted',
      slots: [{
        id: 'slot-1',
        day: 2,
        period: 2,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        locked: false,
        manuallyAdjusted: true,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [{
          type: 'restored_published_draft',
          message: '当前草稿来自恢复发布版，重新发布前建议教务复核。',
        }],
        reviewItems: [{
          type: 'restored_published_draft',
          severity: 'warning',
          targetKind: 'schedule',
          targetName: '恢复发布版',
          message: '当前草稿来自恢复发布版，重新发布前建议教务复核。',
        }],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'draft_changed',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-v2',
        note: '恢复的发布版',
      },
      solverStats: {
        phase: 'manual_adjustment',
        status: 'accepted',
        accepted: true,
        reason: null,
        restoredPublishedDraft: true,
        restoredVersion: 2,
        restoredScheduleId: 'published-v2',
      },
    },
  });

  const status = getSolveStatus(project);
  const inspector = renderInspector(sampleWorkbenchState({ project }));

  assert.equal(status.sourceLabel, '恢复发布版');
  assert.match(inspector, /<b>来源<\/b>恢复发布版/);
  assert.match(inspector, /重新发布前建议教务复核/);
});

test('timetable schedule panel shows animated fast-generation progress while running', () => {
  const state = sampleWorkbenchState({
    loading: true,
    solvePhaseText: '局部优化中',
  });

  const panel = renderSchedulePanel(state);
  const workbench = renderWorkbench(state);

  assert.match(panel, /局部优化中/);
  assert.match(panel, /loader-2/);
  assert.match(panel, /class="tt-spin"/);
  assert.match(panel, /tt-solve-toolbar-chip/);
  assert.match(workbench, /tt-process-strip tt-solve-process/);
  assert.match(workbench, /生成课表/);
  assert.match(workbench, /data-lucide="loader-2" class="tt-spin"/);
});

test('timetable workbench shows fast generation and background optimization status in Chinese', async () => {
  const state = sampleWorkbenchState({
    solverJob: {
      jobId: 'tt-opt-1',
      phase: 'timefold_optimization',
      status: 'running',
      accepted: false,
    },
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'fast-1',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
          locked: false,
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 3, completeness: 33 },
        solverStats: { phase: 'fast_construct', status: 'accepted', lessonCount: 3 },
      },
    }),
  });

  const panel = renderSchedulePanel(state);
  const inspector = renderInspector(state);

  assert.match(panel, /快速生成/);
  assert.match(panel, /Timefold 优化中/);
  assert.match(inspector, /后台优化/);
  assert.match(inspector, /快速课表/);
  assert.doesNotMatch(panel + inspector, /姝ｅ湪|鏁欏姟|璇捐〃|鎺掕/);
});

test('timetable inspector explains initial solution and pinned optimization rejection', () => {
  const state = sampleWorkbenchState({
    solverJob: {
      jobId: 'tt-opt-pinned',
      phase: 'timefold_optimization',
      status: 'failed',
      accepted: false,
      reason: 'pinned_slot_moved',
      solverStats: {
        initialSolutionUsed: true,
        pinnedCount: 2,
        accepted: false,
        reason: 'pinned_slot_moved',
      },
    },
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'manual-1',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual_adjusted',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
          locked: true,
          manuallyAdjusted: true,
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 3, completeness: 33 },
        solverStats: {
          solverUsed: true,
          initialSolutionUsed: true,
          pinnedCount: 2,
          accepted: false,
          reason: 'pinned_slot_moved',
        },
      },
    }),
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /\u521d\u59cb\u89e3/);
  assert.match(inspector, /\u5df2\u4f7f\u7528/);
  assert.match(inspector, /\u9501\u5b9a\u8bfe\u8282/);
  assert.match(inspector, /锁定课节被移动/);
  assert.match(inspector, /已保留当前课表/);
  assert.doesNotMatch(inspector, /pinned_slot_moved/);
});

test('timetable inspector keeps persisted failed optimization details visible after reload', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'fast-timeout-reload',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
          locked: false,
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 3, completeness: 33 },
        solverStats: {
          phase: 'timefold_optimization',
          status: 'failed',
          accepted: false,
          reason: 'timeout',
          lessonCount: 3,
          timeoutSeconds: 210,
        },
      },
    }),
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /后台优化/);
  assert.match(inspector, /<b>优化状态<\/b>Timefold 未完成/);
  assert.match(inspector, /<b>处理结果<\/b>后台优化超时/);
  assert.match(inspector, /<b>优化处理<\/b>已保留当前课表：后台优化超时。/);
  assert.doesNotMatch(inspector, /timeout/);
});

test('timetable inspector translates background optimization rejection reasons for school staff', () => {
  const state = sampleWorkbenchState({
    solverJob: {
      jobId: 'tt-opt-not-better',
      phase: 'timefold_optimization',
      status: 'completed',
      accepted: false,
      reason: 'not_better',
      solverStats: {
        initialSolutionUsed: true,
        pinnedCount: 1,
        accepted: false,
        reason: 'not_better',
      },
    },
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'fast-keep',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
          locked: true,
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 3, completeness: 33 },
        solverStats: {
          initialSolutionUsed: true,
          pinnedCount: 1,
          accepted: false,
          reason: 'not_better',
        },
      },
    }),
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /优化结果没有更好/);
  assert.match(inspector, /已保留当前课表/);
  assert.doesNotMatch(inspector, /not_better/);
});

test('timetable inspector keeps persisted optimization rejection details visible after reload', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'fast-keep-reload',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
          locked: false,
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 3, completeness: 33 },
        solverStats: {
          phase: 'timefold_optimization',
          status: 'completed',
          initialSolutionUsed: true,
          pinnedCount: 1,
          accepted: false,
          reason: 'not_better',
          qualityScoreBefore: 133,
          qualityScoreAfter: 133,
        },
      },
    }),
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /优化结果没有更好/);
  assert.match(inspector, /已保留当前课表/);
  assert.match(inspector, /<b>优化状态<\/b>已保留快速课表/);
  assert.doesNotMatch(inspector, /not_better/);
});

test('timetable data setup uses collapsible groups and compact active range dropdowns', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'Hidden School',
      term: 'Hidden Term',
      weekdays: 5,
      periodsPerDay: 7,
      activeWeekdays: [1, 3, 5],
      activePeriods: [1, 4, 7],
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: null,
    }),
  });

  const html = renderWorkbench(state);
  const panel = renderSchedulePanel(state);

  assert.doesNotMatch(html, /name="schoolName"/);
  assert.doesNotMatch(html, /name="term"/);
  assert.match(html, /data-tt-section-toggle="data"/);
  assert.match(html, /data-tt-section-toggle="rules"/);
  assert.match(html, /data-tt-section-toggle="solve"/);
  assert.match(html, /class="[^"]*tt-workflow-panel[^"]*"/);
  assert.match(html, /class="[^"]*tt-workflow-body[^"]*"/);
  assert.match(html, /data-workflow-step="rules"[\s\S]*?class="[^"]*tt-workflow-body[^"]*"[^>]*>/);
  assert.match(html, /data-workflow-step="rules"[\s\S]*?id="tt-open-rule-review"/);
  assert.match(html, /class="[^"]*tt-rule-stack[^"]*tt-rules-setup-card[^"]*"/);
  assert.equal((html.match(/\btt-workflow-subsection\b/g) || []).length, 5);
  assert.match(html, /class="[^"]*tt-range-setup-card[^"]*tt-workflow-subsection[^"]*"/);
  assert.match(html, /class="[^"]*tt-import-setup-card[^"]*tt-workflow-subsection[^"]*"/);
  assert.match(html, /class="[^"]*tt-rules-setup-card[^"]*tt-workflow-subsection[^"]*"/);
  assert.match(html, /class="[^"]*tt-solve-setup-card[^"]*tt-workflow-subsection[^"]*"/);
  assert.match(html, /class="[^"]*tt-export-setup-card[^"]*tt-workflow-subsection[^"]*"/);
  assert.match(html, /class="[^"]*tt-rules-setup-body[^"]*"/);
  assert.match(html, /class="[^"]*tt-smart-helper-entry[^"]*"/);
  assert.match(html, /class="[^"]*tt-smart-helper-flow[^"]*"/);
  assert.match(html, /class="[^"]*tt-smart-helper-metrics[^"]*"/);
  assert.doesNotMatch(html, /class="[^"]*tt-rule-summary[^"]*"/);
  assert.match(html, /id="tt-range-weekdays-trigger"/);
  assert.match(html, /id="tt-range-periods-trigger"/);
  const weekdayTrigger = html.match(/<button class="[^"]*" id="tt-range-weekdays-trigger"[\s\S]*?<\/button>/)?.[0] || '';
  const periodTrigger = html.match(/<button class="[^"]*" id="tt-range-periods-trigger"[\s\S]*?<\/button>/)?.[0] || '';
  const renderWeekdayTrigger = activeWeekdays => {
    const weekdayHtml = renderWorkbench(sampleWorkbenchState({
      project: {
        ...state.project,
        weekdays: Math.max(...activeWeekdays),
        activeWeekdays,
      },
    }));
    return weekdayHtml.match(/<button class="[^"]*" id="tt-range-weekdays-trigger"[\s\S]*?<\/button>/)?.[0] || '';
  };
  const workdayTrigger = renderWeekdayTrigger([1, 2, 3, 4, 5]);
  const midweekTrigger = renderWeekdayTrigger([2, 3, 4]);
  const allWeekTrigger = renderWeekdayTrigger([1, 2, 3, 4, 5, 6, 7]);
  assert.match(weekdayTrigger, /tt-multi-select-trigger--summary-only/);
  assert.match(periodTrigger, /tt-multi-select-trigger--summary-only/);
  assert.match(weekdayTrigger, /data-range-popover-trigger="activeWeekdays"/);
  assert.match(periodTrigger, /data-range-popover-trigger="activePeriods"/);
  assert.match(weekdayTrigger, /aria-expanded="false"/);
  assert.doesNotMatch(weekdayTrigger, /<span>可用周几<\/span>/);
  assert.doesNotMatch(periodTrigger, /<span>可用节次<\/span>/);
  assert.match(weekdayTrigger, /<strong>/);
  assert.match(periodTrigger, /<strong>/);
  assert.match(weekdayTrigger, /周一、周三、周五/);
  assert.match(workdayTrigger, /周一至周五/);
  assert.doesNotMatch(workdayTrigger, /周一-周五/);
  assert.match(midweekTrigger, /周二至周四/);
  assert.match(allWeekTrigger, /全周/);
  assert.doesNotMatch(html, /id="tt-apply-range"/);
  assert.doesNotMatch(html, /id="tt-reset-range"/);
  assert.doesNotMatch(html, /data-range-popover-panel/);
  assert.doesNotMatch(html, /tt-range-setup-card[\s\S]*tt-multi-select-popover/);
  assert.doesNotMatch(html, /data-active-weekday="1"[^>]*checked/);
  assert.doesNotMatch(html, /data-active-period="4"[^>]*checked/);
  const weekdayPopoverHtml = renderWorkbench({
    ...state,
    rangePopover: { id: 'activeWeekdays', rect: { top: 140, left: 88, width: 260 } },
  });
  assert.match(weekdayPopoverHtml, /class="tt-floating-popover-layer"/);
  assert.match(weekdayPopoverHtml, /data-range-popover-panel="activeWeekdays"/);
  assert.match(weekdayPopoverHtml, /工作日/);
  assert.match(weekdayPopoverHtml, /全周/);
  assert.match(weekdayPopoverHtml, /data-range-apply/);
  assert.match(weekdayPopoverHtml, /data-range-popover-close/);
  assert.match(weekdayPopoverHtml, /data-active-weekday="1"[^>]*checked/);
  assert.match(weekdayPopoverHtml, /data-active-weekday="3"[^>]*checked/);
  assert.match(weekdayPopoverHtml, /data-active-weekday="5"[^>]*checked/);
  const periodPopoverHtml = renderWorkbench({
    ...state,
    rangePopover: { id: 'activePeriods', rect: { top: 210, left: 88, width: 260 } },
  });
  assert.match(periodPopoverHtml, /data-range-popover-panel="activePeriods"/);
  assert.match(periodPopoverHtml, /第1-7节/);
  assert.match(periodPopoverHtml, /全部节次/);
  assert.match(periodPopoverHtml, /data-active-period="4"[^>]*checked/);
  assert.doesNotMatch(html, /tt-chip-grid--range/);
  assert.match(html, /class="tt-roster-stats"/);
  assert.match(html, /id="tt-clear-roster"/);
  assert.match(html, /id="tt-reopen-roster-import"/);
  assert.match(html, /id="tt-edit-roster"/);
  assert.doesNotMatch(html, /id="tt-import-text"/);
  assert.doesNotMatch(html, /id="tt-import-roster"/);
  assert.doesNotMatch(html, /class="tt-plan-list"/);
  assert.doesNotMatch(html, /class="tt-plan-row"/);
  // 智能 constraints use the same compact entry + modal workflow as roster import.
  assert.match(html, /id="tt-open-rule-review"/);
  assert.doesNotMatch(html, /id="tt-rule-input-area"/);
  assert.doesNotMatch(html, /id="tt-rule-input-text"/);
  assert.doesNotMatch(html, /id="tt-rule-parse-btn"/);
  assert.doesNotMatch(html, /id="tt-rule-manual-add-btn"/);
  assert.doesNotMatch(html, /id="tt-pending-rules"/);
  assert.doesNotMatch(html, /id="tt-saved-rules"/);
  assert.doesNotMatch(html, /id="tt-open-bulk-rule-review"/);
  assert.doesNotMatch(html, /id="tt-add-lock"/);
  assert.doesNotMatch(html, /class="tt-lock-list"/);
  assert.doesNotMatch(html, /id="tt-rule-prompt"/);
  assert.doesNotMatch(html, /id="tt-rule-file"/);
  assert.doesNotMatch(html, /id="tt-parse-rules"/);
  assert.doesNotMatch(html, /id="tt-confirm-rule-draft"/);
  assert.doesNotMatch(html, /id="tt-add-bulk-rule"/);
  assert.doesNotMatch(html, /id="tt-bulk-rule-type"/);
  assert.doesNotMatch(html, /id="tt-bulk-days-trigger"/);
  assert.doesNotMatch(html, /id="tt-bulk-periods-trigger"/);

  assert.match(panel, /style="--tt-days:3"/);
  assert.match(panel, /data-day="1"/);
  assert.match(panel, /data-day="3"/);
  assert.doesNotMatch(panel, /data-day="2"/);
  assert.match(panel, /data-period="4"/);
  assert.doesNotMatch(panel, /data-period="2"/);
});

test('timetable workflow sibling subsections use one theme-aware separation band', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const dividerRule = styles.match(/\.tt-workflow-subsection \+ \.tt-workflow-subsection::before\s*\{[^}]*\}/)?.[0] || '';
  const lightDividerRule = styles.match(/body\.light-mode \.tt-workflow-subsection \+ \.tt-workflow-subsection::before\s*\{[^}]*\}/)?.[0] || '';

  assert.match(styles, /--tt-workflow-divider:\s*rgba\(148, 163, 184, 0\.42\);/);
  assert.match(styles, /body\.light-mode \.tt-workbench\s*\{[^}]*--tt-workflow-divider:\s*rgba\(63, 111, 124, 0\.3\);/);
  assert.match(styles, /\.tt-workflow-body\s*\{[^}]*gap:\s*var\(--tt-space-lg\);/);
  assert.match(styles, /\.tt-workflow-subsection\s*\{[^}]*position:\s*relative;/);
  assert.doesNotMatch(styles, /\.tt-setup-card \+ \.tt-setup-card/);
  assert.match(dividerRule, /content:\s*"";/);
  assert.match(dividerRule, /top:\s*-12px;/);
  assert.match(dividerRule, /left:\s*8px;/);
  assert.match(dividerRule, /right:\s*8px;/);
  assert.match(dividerRule, /height:\s*2px;/);
  assert.match(dividerRule, /transparent 0%/);
  assert.match(dividerRule, /var\(--tt-workflow-divider\) 10%/);
  assert.match(dividerRule, /var\(--tt-workflow-divider\) 90%/);
  assert.match(dividerRule, /transparent 100%/);
  assert.match(dividerRule, /pointer-events:\s*none;/);
  assert.doesNotMatch(dividerRule, /filter|box-shadow/);
  assert.match(lightDividerRule, /left:\s*16px;/);
  assert.match(lightDividerRule, /right:\s*16px;/);
  assert.match(lightDividerRule, /height:\s*1px;/);
});

test('timetable roster import is opened from a data card instead of permanent sidebar controls', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [],
      classes: [],
      subjects: [],
      lessonPlans: [],
      rules: { hardRules: {}, softRules: {} },
      schedule: null,
    }),
  });

  const closed = renderWorkbench(state);
  assert.match(closed, /id="tt-open-roster-import"/);
  assert.match(closed, /class="[^"]*tt-roster-entry[^"]*"/);
  assert.match(closed, /data-roster-import-trigger/);
  assert.doesNotMatch(closed, /id="tt-import-text"/);
  assert.doesNotMatch(closed, /id="tt-import-file"/);
  assert.doesNotMatch(closed, /id="tt-import-roster"/);
  assert.doesNotMatch(closed, /id="tt-roster-import-dialog"/);

  const open = renderWorkbench({
    ...state,
    rosterImport: {
      open: true,
      mode: 'text',
      fileName: '',
      text: '',
    },
  });
  assert.match(open, /id="tt-roster-import-dialog"/);
  assert.match(open, /<section class="tt-roster-import-dialog" id="tt-roster-import-dialog"/);
  assert.doesNotMatch(open, /tt-roster-import-dialog--review/);
  assert.match(open, /class="tt-roster-import-options"/);
  assert.match(open, /<h4 id="tt-roster-import-file-title">上传文件<\/h4>[\s\S]*智能 CSV \/ TXT \/ Excel 文件导入/);
  assert.match(open, /<h4 id="tt-roster-import-text-title">粘贴文本<\/h4>[\s\S]*支持表格数据，也可尝试自然语言描述/);
  assert.match(open, /<h4 id="tt-roster-import-manual-title">手动新增<\/h4>[\s\S]*列好空白任课表，让用户自己手动新增/);
  assert.equal((open.match(/tt-roster-import-option-body/g) || []).length, 3);
  assert.equal((open.match(/<div class="tt-roster-import-option-actions/g) || []).length, 3);
  assert.equal((open.match(/tt-roster-import-option-actions--full/g) || []).length, 2);
  assert.match(open, /id="tt-roster-import-file"/);
  assert.match(open, /\.csv \/ \.txt \/ \.xlsx \/ \.xls/);
  assert.match(open, /id="tt-roster-import-text"/);
  assert.match(open, /placeholder="每条任课一行，支持带表头的表格数据或自然语言描述。&#10;至少包含：班级、课程、教师、周课时。"/);
  assert.match(open, /id="tt-fill-roster-sample"[\s\S]*填入示例/);
  assert.match(open, /id="tt-start-empty-roster-review"/);
  assert.match(open, /id="tt-cancel-roster-import"/);
  assert.match(open, /data-roster-import-submit="file"/);
  assert.match(open, /data-roster-import-submit="text"/);
  assert.match(open, /打开空白表/);
  assert.doesNotMatch(open, /id="tt-roster-review-table"/);
  assert.doesNotMatch(open, /tt-import-mode-tabs/);
  assert.doesNotMatch(open, /data-roster-import-mode="file"/);
  assert.doesNotMatch(open, /data-roster-import-mode="text"/);

  const inputWithDraft = renderWorkbench({
    ...state,
    rosterImport: {
      ...createTimetablePlannerState().rosterImport,
      open: true,
      step: 'input',
      mode: 'file',
      draftRows: [{
        id: 'retained_1',
        grade: 'G7',
        className: '1班',
        subjectName: 'Math',
        teacherName: 'Alice',
        weeklyHours: 4,
      }],
      stats: { planCount: 1 },
    },
  });
  assert.match(inputWithDraft, /id="tt-resume-roster-review"/);
  assert.match(inputWithDraft, /继续复核（1 条）/);
  assert.match(inputWithDraft, /重新解析并替换/);

  const review = renderWorkbench({
    ...state,
    rosterImport: {
      open: true,
      step: 'review',
      mode: 'text',
      fileName: '',
      text: '',
      draftRows: [{
        id: 'draft_1',
        sourceRow: 257,
        sourceSheet: '任课数据',
        grade: 'G7',
        className: '1',
        subjectName: 'Math',
        subjectCategory: 'main',
        subjectTags: ['core', 'exam'],
        teacherName: 'Alice/Bob',
        weeklyHours: 4,
        blockPreference: 'double',
        roomName: 'Lab A/Lab B',
        activityTypes: ['普通课', '实验课程', '校本研修课'],
        requiredResourceTypes: ['机房', '创客空间'],
        issues: [],
      }, {
        id: 'draft_2',
        grade: 'G8',
        className: '2',
        subjectName: 'Physics',
        subjectCategory: 'normal',
        subjectTags: [],
        teacherName: 'Carol',
        weeklyHours: 3,
        blockPreference: 'single',
        roomName: '',
        issues: [],
      }, {
        id: 'draft_3',
        grade: 'G9',
        className: '3',
        subjectName: 'Review Lab',
        subjectCategory: 'normal',
        subjectTags: [],
        teacherName: 'Dana',
        weeklyHours: 2,
        blockPreference: 'single',
        roomName: '',
        activityTypes: ['复习课'],
        requiredResourceTypes: ['机房'],
        issues: [],
      }],
      stats: { classCount: 2, teacherCount: 3, subjectCount: 2, planCount: 2, totalLessons: 7, blockLessons: 4, fixedRoomCount: 2, issueCount: 0 },
      issues: [],
      warnings: [],
    },
  });
  assert.match(review, /id="tt-roster-review-table"/);
  assert.match(review, /<section class="tt-roster-import-dialog tt-roster-import-dialog--review" id="tt-roster-import-dialog"/);
  assert.match(review, /data-roster-review-row="draft_1"/);
  assert.match(review, /data-roster-source-row="257"/);
  assert.match(review, /data-roster-source-sheet="任课数据"/);
  assert.match(review, /data-roster-field="grade"/);
  assert.match(review, /data-roster-field="className"/);
  assert.match(review, /data-roster-field="subjectName"/);
  assert.match(review, /data-roster-field="subjectCategory"[^>]*aria-label="课程类型"[^>]*title="普通：常规课程，按普通课程安排；主科：语文、数学、英语等核心课程；素质：体育、音乐、美术、劳动等课程；实验：需要实验室或实验安排的课程。不确定时选“普通”；核心考试科目选“主科”；实验课选“实验”。"/);
  assert.match(review, /data-roster-field="subjectTags"/);
  assert.match(review, /data-roster-field="teacherName"/);
  assert.match(review, /data-roster-field="weeklyHours"[^>]*aria-label="周课时"[^>]*title="表示这个班级这门课每周要排几节；填 5，就是每周排 5 节这门课。"/);
  assert.match(review, /data-roster-field="blockPreference"[^>]*aria-label="连堂方式"[^>]*title="单节：每次只排 1 节课；双连堂：每次连续排 2 节课，周课时建议为偶数；混合：单节和连堂都可。不确定时选“混合”；明确不要连堂选“单节”；需要连续时间选“双连堂”。"/);
  assert.match(review, /data-roster-field="roomName"/);
  const importedRow = review.match(/data-roster-review-row="draft_1"[\s\S]*?<\/tr>/)?.[0] || '';
  const emptyRow = review.match(/data-roster-review-row="draft_2"[\s\S]*?<\/tr>/)?.[0] || '';
  const aliasRow = review.match(/data-roster-review-row="draft_3"[\s\S]*?<\/tr>/)?.[0] || '';
  assert.match(importedRow, /data-roster-field="activityTypes"[^>]*title="普通课、实验课、校本研修课（导入值）"[\s\S]*<option value="普通课、实验课、校本研修课" selected>普通课、实验课、校本研修课（导入值）<\/option>/);
  assert.match(importedRow, /data-roster-field="requiredResourceTypes"[^>]*title="计算机教室、创客空间（导入值）"[\s\S]*<option value="计算机教室、创客空间" selected>计算机教室、创客空间（导入值）<\/option>/);
  assert.match(emptyRow, /data-roster-field="activityTypes"[^>]*title="未选择"[\s\S]*<option value="" selected>未选择<\/option>/);
  assert.match(aliasRow, /data-roster-field="activityTypes"[^>]*title="复习"[\s\S]*<option value="复习" selected>复习<\/option>/);
  assert.match(aliasRow, /data-roster-field="requiredResourceTypes"[^>]*title="计算机教室"[\s\S]*<option value="计算机教室" selected>计算机教室<\/option>/);
  assert.doesNotMatch(review, /data-roster-metadata|tt-popover-header/);
  assert.match(review, /data-roster-delete-row="draft_1"/);
  assert.match(review, /<colgroup class="tt-roster-review-cols">/);
  assert.match(review, /class="tt-roster-col-row-number"/);
  assert.match(review, /<th>行号<\/th>/);
  assert.match(review, /class="tt-roster-block-help"[\s\S]*<span>类型<\/span>[\s\S]*class="tt-roster-block-help-trigger"[^>]*aria-label="查看类型说明"[^>]*>\?<\/button>/);
  assert.match(review, /class="tt-roster-block-help"[\s\S]*<span>周课时<\/span>[\s\S]*class="tt-roster-block-help-trigger"[^>]*aria-label="查看周课时说明"[^>]*>\?<\/button>/);
  assert.match(review, /class="tt-roster-block-help"[\s\S]*<span>连堂<\/span>[\s\S]*class="tt-roster-block-help-trigger"[^>]*aria-label="查看连堂说明"[^>]*>\?<\/button>/);
  assert.match(review, /aria-label="查看课型说明"/);
  assert.match(review, /id="tt-roster-activity-help-text"[\s\S]*选择这条任课计划的主要课型[\s\S]*智能约束助手会用该标签定位课程/);
  assert.match(review, /aria-label="查看资源说明"/);
  assert.match(review, /id="tt-roster-resource-help-text"[\s\S]*选择这条任课计划的主要资源类型[\s\S]*不会单独指定教室/);
  const categoryHelp = review.match(/id="tt-roster-category-help-text" role="tooltip">([\s\S]*?)<\/span>/)?.[1] || '';
  assert.match(categoryHelp, /<b>普通：<\/b>常规课程，按普通课程安排。[\s\S]*<b>主科：<\/b>语文、数学、英语等核心课程。[\s\S]*<b>素质：<\/b>体育、音乐、美术、劳动等课程。[\s\S]*<b>实验：<\/b>需要实验室或实验安排的课程。[\s\S]*<em>不确定时选“普通”；核心考试科目选“主科”；实验课选“实验”。<\/em>/);
  assert.doesNotMatch(categoryHelp, /功能教室/);
  const weeklyHoursHelp = review.match(/id="tt-roster-weekly-hours-help-text" role="tooltip">([\s\S]*?)<\/span>/)?.[1] || '';
  assert.match(weeklyHoursHelp, /表示这个班级这门课每周要排几节。[\s\S]*填 5，就是每周排 5 节这门课。/);
  assert.doesNotMatch(weeklyHoursHelp, /双连堂|教学计划/);
  assert.match(review, /id="tt-roster-block-help-text" role="tooltip"[\s\S]*<b>单节：<\/b>每次只排 1 节课。[\s\S]*<b>双连堂：<\/b>每次连续排 2 节课，周课时建议为偶数。[\s\S]*<b>混合：<\/b>单节和连堂都可。[\s\S]*<em>不确定时选“混合”；明确不要连堂选“单节”；需要连续时间选“双连堂”。<\/em>/);
  assert.match(review, /class="tt-roster-col-grade"/);
  assert.match(review, /class="tt-roster-col-issue"/);
  assert.match(review, /class="tt-roster-col-action"/);
  assert.match(review, /data-label="行号"><span class="tt-roster-review-row-number" title="第 1 行 · 来源：任课数据 · 源文件第 257 行">1<\/span>/);
  assert.match(review, /data-roster-review-row="draft_2"[\s\S]*data-label="行号"><span class="tt-roster-review-row-number" title="当前第 2 行">2<\/span>/);
  assert.match(review, /class="tt-roster-review-issue" title="无">无<\/span>/);
  assert.match(review, /class="tt-dialog-actions tt-roster-review-actions"/);
  assert.match(review, /id="tt-back-roster-import"[\s\S]*返回导入方式/);
  assert.match(review, /id="tt-add-roster-review-row"/);
  assert.match(review, /id="tt-open-roster-append"[\s\S]*批量追加/);
  assert.doesNotMatch(review, /id="tt-roster-bulk-text"/);
  assert.match(review, /id="tt-confirm-roster-import"/);

  const appendOpen = renderWorkbench({
    ...state,
    rosterImport: {
      ...createTimetablePlannerState().rosterImport,
      open: true,
      step: 'review',
      draftRows: [{
        id: 'draft_1',
        grade: 'G7',
        className: '1班',
        subjectName: 'Math',
        teacherName: 'Alice',
        weeklyHours: 4,
      }],
      stats: { planCount: 1 },
      appendDialog: {
        open: true,
        text: 'G8,2班,语文,李老师,5',
        loading: true,
        error: '',
        requestId: 3,
        lastSummary: null,
      },
    },
  });
  assert.match(appendOpen, /id="tt-roster-append-dialog"/);
  assert.match(appendOpen, /id="tt-roster-append-text"[\s\S]*G8,2班,语文,李老师,5/);
  assert.match(appendOpen, /id="tt-submit-roster-append"[^>]*disabled[\s\S]*解析中/);
});

test('timetable roster review numbers rows sequentially and highlights duplicate warnings', () => {
  const controller = new TimetablePlannerController();
  const analyzed = controller.analyzeRosterDraftRows([{
    id: 'original', sourceSheetId: 'sheet-1', sourceSheet: '任课数据', sourceRow: 2,
    grade: '七年级', className: 'G7-1班', subjectName: '语文', teacherName: '刘书涵', weeklyHours: 5,
  }, {
    id: 'duplicate', sourceSheet: '追加文本', sourceRow: 1,
    grade: '七年级', className: 'G7-1班', subjectName: '语文', teacherName: '刘书涵', weeklyHours: 5,
  }]);
  const html = renderWorkbench(sampleWorkbenchState({
    rosterImport: {
      open: true,
      step: 'review',
      draftRows: analyzed.draftRows,
      stats: analyzed.stats,
      issues: analyzed.issues,
      warnings: analyzed.warnings,
      hasBlockingIssues: false,
    },
  }));
  const originalRow = html.match(/<tr class="[^"]*"[\s\S]*?data-roster-review-row="original"[\s\S]*?<\/tr>/)?.[0] || '';
  const duplicateRow = html.match(/<tr class="[^"]*"[\s\S]*?data-roster-review-row="duplicate"[\s\S]*?<\/tr>/)?.[0] || '';

  assert.match(originalRow, /title="第 1 行 · 来源：任课数据 · 源文件第 2 行">1<\/span>/);
  assert.doesNotMatch(originalRow, /tt-roster-review-row--duplicate/);
  assert.match(duplicateRow, /tt-roster-review-row--duplicate/);
  assert.match(duplicateRow, /title="第 2 行 · 来源：追加文本 · 文本第 1 行">2<\/span>/);
  assert.match(duplicateRow, /data-roster-jump-row="original"/);
  assert.match(duplicateRow, /class="tt-roster-review-issue tt-roster-review-issue--duplicate"/);
  assert.match(duplicateRow, />重复<\/span>/);
  assert.equal(analyzed.issues[0].code, 'duplicate_roster');
  assert.equal(analyzed.issues[0].duplicateOfRowId, 'original');
  assert.equal(analyzed.issues[0].duplicateOfReviewRow, 1);
  assert.match(analyzed.issues[0].message, /与第 1 行重复/);
});

test('timetable roster import review renders editable issue summaries', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    id: `draft_${index + 1}`,
    sourceRow: index === 0 ? 37 : 38 + index,
    sourceSheet: '任课数据',
    grade: '八年级',
    className: `G8-${index + 1}班`,
    subjectName: index === 0 ? '物理' : '数学',
    subjectCategory: 'main',
    subjectTags: [],
    teacherName: index === 0 ? '程远航' : `教师${index + 1}`,
    weeklyHours: index === 0 ? 3 : 5,
    blockPreference: 'double',
    roomName: '',
    issues: [{
      rowId: `draft_${index + 1}`,
      sourceRow: index === 0 ? 37 : 38 + index,
      sourceSheet: '任课数据',
      severity: 'warning',
      field: 'blockPreference',
      message: '双连堂课时建议使用偶数。',
    }],
  }));
  const issues = rows.map(row => row.issues[0]);
  const baseRosterImport = {
    open: true,
    step: 'review',
    mode: 'file',
    fileName: 'roster.xlsx',
    text: '',
    draftRows: rows,
    stats: { classCount: 20, teacherCount: 20, subjectCount: 2, planCount: 20, totalLessons: 100, blockLessons: 100, fixedRoomCount: 0, issueCount: 20 },
    issues,
    warnings: ['双连堂课时建议使用偶数。'],
  };

  const collapsed = renderWorkbench(sampleWorkbenchState({ rosterImport: baseRosterImport }));
  assert.match(collapsed, /共 20 条，显示前 4 条/);
  assert.match(collapsed, /显示全部 16/);
  assert.equal((collapsed.match(/data-roster-edit-issue-row=/g) || []).length, 4);
  assert.match(collapsed, /data-roster-edit-issue-row="draft_1"/);
  assert.match(collapsed, /data-roster-edit-issue-field="blockPreference"/);
  assert.match(collapsed, /第 37 行 · G8-1班 · 物理 · 程远航 · 周课时 3 · 双连堂课时建议使用偶数。/);
  assert.match(collapsed, /data-roster-source-row="37"/);
  assert.match(collapsed, /data-roster-source-sheet="任课数据"/);
  assert.match(collapsed, /class="tt-roster-review-issue" title="双连堂课时建议使用偶数。">双连堂课时建议使用偶数。<\/span>/);
  assert.doesNotMatch(collapsed, /data-roster-edit-issue-row="draft_20"/);
  assert.doesNotMatch(collapsed, /data-roster-jump-row="draft_1"/);

  const expanded = renderWorkbench(sampleWorkbenchState({
    rosterImport: { ...baseRosterImport, issueListExpanded: true },
  }));
  assert.match(expanded, /共 20 条/);
  assert.match(expanded, /收起/);
  assert.equal((expanded.match(/data-roster-edit-issue-row=/g) || []).length, 20);
  assert.match(expanded, /data-roster-edit-issue-row="draft_20"/);
});

test('timetable roster issue editor renders row context and quick fixes', () => {
  const row = {
    id: 'draft_chem',
    sourceRow: 257,
    sourceSheet: '任课数据',
    grade: '九年级',
    className: 'G9-1班',
    subjectName: '化学',
    subjectCategory: 'lab',
    subjectTags: [],
    teacherName: '丁子航',
    weeklyHours: 3,
    blockPreference: 'double',
    roomName: '化学实验室',
    issues: [{
      rowId: 'draft_chem',
      sourceRow: 257,
      sourceSheet: '任课数据',
      severity: 'warning',
      field: 'blockPreference',
      message: '双连堂课时建议使用偶数。',
    }],
  };
  const issue = row.issues[0];
  const html = renderWorkbench(sampleWorkbenchState({
    rosterImport: {
      open: true,
      step: 'review',
      mode: 'file',
      fileName: 'roster.xlsx',
      text: '',
      draftRows: [row],
      stats: { classCount: 1, teacherCount: 1, subjectCount: 1, planCount: 1, totalLessons: 3, blockLessons: 3, fixedRoomCount: 1, issueCount: 1 },
      issues: [issue],
      warnings: ['双连堂课时建议使用偶数。'],
      issueEditor: {
        rowId: 'draft_chem',
        field: 'blockPreference',
        issue,
        draft: row,
      },
    },
  }));

  assert.match(html, /id="tt-roster-issue-editor-dialog"/);
  assert.match(html, /修正任课问题/);
  assert.match(html, /表格第 257 行 · G9-1班 · 化学 · 丁子航/);
  assert.match(html, /双连堂课时建议使用偶数。/);
  assert.match(html, /周课时 3 · 双连堂/);
  assert.match(html, /data-roster-issue-field="grade"[^>]*value="九年级"/);
  assert.match(html, /data-roster-issue-field="className"[^>]*value="G9-1班"/);
  assert.match(html, /data-roster-issue-field="subjectName"[^>]*value="化学"/);
  assert.match(html, /data-roster-issue-field="teacherName"[^>]*value="丁子航"/);
  assert.match(html, /data-roster-issue-field="weeklyHours"[^>]*type="number"[^>]*value="3"[^>]*aria-label="周课时"[^>]*title="表示这个班级这门课每周要排几节；填 5，就是每周排 5 节这门课。"/);
  assert.match(html, /data-roster-issue-field="blockPreference"[^>]*aria-label="连堂方式"[^>]*title="单节：每次只排 1 节课；双连堂：每次连续排 2 节课，周课时建议为偶数；混合：单节和连堂都可。不确定时选“混合”；明确不要连堂选“单节”；需要连续时间选“双连堂”。"/);
  assert.match(html, /data-roster-issue-field="roomName"[^>]*value="化学实验室"/);
  assert.match(html, /data-roster-issue-quick-fix="mixed"[^>]*>改为混合/);
  assert.match(html, /data-roster-issue-quick-fix="single"[^>]*>改为单节/);
  assert.match(html, /data-roster-issue-quick-fix="nextEven"[^>]*>周课时改为下一个偶数/);
  assert.match(html, /id="tt-roster-issue-locate-original"/);
  assert.match(html, /data-roster-jump-row="draft_chem"/);
  assert.match(html, /data-roster-jump-field="blockPreference"/);
  assert.match(html, /class="tt-roster-issue-editor-progress"[^>]*>第 1 \/ 1 条<\/span>/);
  assert.match(html, /id="tt-roster-issue-prev"[^>]*disabled/);
  assert.match(html, /id="tt-roster-issue-next"[^>]*disabled/);
  assert.match(html, /id="tt-save-roster-issue-editor"[^>]*data-roster-issue-save-mode="close"[\s\S]*保存修改/);
});

test('timetable roster issue editor renders navigation progress and save mode', () => {
  const rows = ['物理', '化学'].map((subjectName, index) => ({
    id: `draft_${index + 1}`,
    sourceRow: 30 + index,
    sourceSheet: '任课数据',
    grade: '九年级',
    className: `G9-${index + 1}班`,
    subjectName,
    subjectCategory: 'main',
    subjectTags: [],
    teacherName: `教师${index + 1}`,
    weeklyHours: 3,
    blockPreference: 'double',
    roomName: '',
    issues: [{
      rowId: `draft_${index + 1}`,
      sourceRow: 30 + index,
      sourceSheet: '任课数据',
      severity: 'warning',
      field: 'blockPreference',
      message: '双连堂课时建议使用偶数。',
    }],
  }));
  const issues = rows.map(row => row.issues[0]);
  const baseRosterImport = {
    open: true,
    step: 'review',
    mode: 'file',
    fileName: 'roster.xlsx',
    text: '',
    draftRows: rows,
    stats: { classCount: 2, teacherCount: 2, subjectCount: 2, planCount: 2, totalLessons: 6, blockLessons: 6, fixedRoomCount: 0, issueCount: 2 },
    issues,
    warnings: ['双连堂课时建议使用偶数。'],
  };

  const firstHtml = renderWorkbench(sampleWorkbenchState({
    rosterImport: {
      ...baseRosterImport,
      issueEditor: {
        rowId: 'draft_1',
        field: 'blockPreference',
        issue: issues[0],
        draft: rows[0],
      },
    },
  }));
  assert.match(firstHtml, /class="tt-roster-issue-editor-progress"[^>]*>第 1 \/ 2 条<\/span>/);
  assert.match(firstHtml, /id="tt-roster-issue-prev"[^>]*disabled/);
  assert.match(firstHtml, /id="tt-roster-issue-next"(?![^>]*disabled)/);
  assert.match(firstHtml, /id="tt-save-roster-issue-editor"[^>]*data-roster-issue-save-mode="next"[\s\S]*保存并下一条/);

  const secondHtml = renderWorkbench(sampleWorkbenchState({
    rosterImport: {
      ...baseRosterImport,
      issueEditor: {
        rowId: 'draft_2',
        field: 'blockPreference',
        issue: issues[1],
        draft: rows[1],
      },
    },
  }));
  assert.match(secondHtml, /class="tt-roster-issue-editor-progress"[^>]*>第 2 \/ 2 条<\/span>/);
  assert.match(secondHtml, /id="tt-roster-issue-prev"(?![^>]*disabled)/);
  assert.match(secondHtml, /id="tt-roster-issue-next"[^>]*disabled/);
  assert.match(secondHtml, /id="tt-save-roster-issue-editor"[^>]*data-roster-issue-save-mode="close"[\s\S]*保存修改/);
});

test('timetable roster import review renders the import report summary and entries', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    rosterImport: {
      open: true,
      step: 'review',
      mode: 'text',
      fileName: '',
      text: '',
      draftRows: [{
        id: 'draft_1',
        grade: 'G8',
        className: '1班',
        subjectName: '数学',
        subjectCategory: 'main',
        subjectTags: [],
        teacherName: '张老师',
        weeklyHours: 4,
        blockPreference: 'double',
        roomName: '',
        issues: [],
      }],
      stats: { classCount: 1, teacherCount: 1, subjectCount: 1, planCount: 1, totalLessons: 4, blockLessons: 4, fixedRoomCount: 0, issueCount: 1 },
      issues: [],
      warnings: ['存在重复任课，请确认是否需要合并。'],
      importReport: {
        sourceKind: 'roster',
        summary: { total: 3, kept: 1, degraded: 1, dropped: 0, review: 1 },
        entries: [{
          category: 'kept',
          source: { row: 2, rowId: 'draft_1' },
          field: 'row',
          reason: '任课行已保留。',
        }, {
          category: 'degraded',
          source: { row: 4, rowId: 'draft_3' },
          field: 'blockPreference',
          reason: '无法识别“三连堂”，已按单节处理。',
          originalValue: '三连堂',
        }, {
          category: 'review',
          source: { row: 3, rowId: 'draft_2' },
          field: 'subjectName',
          reason: '存在重复任课，请确认是否需要合并。',
        }],
        hasIssues: true,
      },
    },
  }));

  assert.match(html, /导入报告/);
  assert.match(html, /保留<\/b>1/);
  assert.match(html, /降级<\/b>1/);
  assert.match(html, /丢弃<\/b>0/);
  assert.match(html, /待审<\/b>1/);
  assert.match(html, /无法识别“三连堂”，已按单节处理。/);
  assert.match(html, /存在重复任课，请确认是否需要合并。/);
});

test('timetable roster import report hides kept-only detail rows', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    rosterImport: {
      open: true,
      step: 'review',
      mode: 'text',
      fileName: '',
      text: '',
      draftRows: [],
      stats: { classCount: 30, teacherCount: 62, subjectCount: 14, planCount: 360, totalLessons: 900, blockLessons: 160, fixedRoomCount: 0, issueCount: 0 },
      issues: [],
      importReport: {
        sourceKind: 'roster',
        summary: { total: 360, kept: 360, degraded: 0, dropped: 0, review: 0 },
        entries: [
          { category: 'kept', source: { row: 2 }, field: 'row', reason: '任课行已保留。' },
          { category: 'kept', source: { row: 3 }, field: 'row', reason: '任课行已保留。' },
          { category: 'kept', source: { row: 4 }, field: 'row', reason: '任课行已保留。' },
        ],
        hasIssues: false,
      },
    },
  }));

  assert.match(html, /导入报告/);
  assert.match(html, /保留<\/b>360/);
  assert.match(html, /降级<\/b>0/);
  assert.match(html, /丢弃<\/b>0/);
  assert.match(html, /待审<\/b>0/);
  assert.doesNotMatch(html, /任课行已保留。/);
  assert.doesNotMatch(html, /tt-rule-warning-list/);
});

test('timetable roster review renders worksheet provenance and parser call summary', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    rosterImport: {
      open: true,
      step: 'review',
      mode: 'file',
      source: 'mixed',
      draftRows: [{
        id: 'draft_sheet-1_2',
        sourceSheetId: 'sheet-1',
        sourceSheet: '任课数据',
        sourceRow: 2,
        parseSource: 'local',
        grade: '七年级',
        className: '1班',
        subjectName: '语文',
        subjectCategory: 'main',
        subjectTags: ['主科'],
        teacherName: '林老师',
        weeklyHours: 5,
        blockPreference: 'single',
        roomName: 'A101',
        activityTypes: [],
        requiredResourceTypes: [],
        issues: [],
      }],
      stats: { classCount: 1, teacherCount: 1, subjectCount: 1, planCount: 1, totalLessons: 5, blockLessons: 0, fixedRoomCount: 1, issueCount: 0 },
      issues: [],
      warnings: [],
      importReport: { summary: { total: 1, kept: 1, degraded: 0, dropped: 0, review: 0 }, entries: [], hasIssues: false },
      sheetReviews: [
        { id: 'sheet-1', name: '任课数据', index: 0, selected: true, status: 'included', headerRow: 1, rowCount: 1, parseSource: 'local', reason: '已识别标准任课表头。' },
        { id: 'sheet-2', name: '说明', index: 1, selected: false, status: 'ignored', headerRow: null, rowCount: 0, parseSource: 'none', reason: '内容不像任课明细表。' },
      ],
      parseSummary: { format: 'xlsx', sheetCount: 2, includedSheetCount: 1, localRowCount: 1, aiRowCount: 0, aiAttempted: true, aiCallCount: 1 },
    },
  }));

  assert.match(html, /混合解析/);
  assert.match(html, /XLSX · 1\/2 个工作表 · 本地 1 行 · AI 0 行 \/ 1 次/);
  assert.match(html, /data-roster-sheet-toggle="sheet-1" checked/);
  assert.match(html, /data-roster-sheet-toggle="sheet-2"[^>]*disabled/);
  assert.match(html, /第 1 行 · 来源：任课数据 · 源文件第 2 行/);
  assert.match(html, /data-roster-source-sheet-id="sheet-1"/);
  assert.match(html, /data-roster-parse-source="local"/);
});

test('timetable roster worksheet toggles preserve edited rows and recompute selected statistics', () => {
  const controller = new TimetablePlannerController();
  const first = {
    id: 'row-1', sourceSheetId: 'sheet-1', sourceSheet: '七年级', sourceRow: 2, parseSource: 'local',
    grade: '七年级', className: '1班', subjectName: '语文', subjectCategory: 'main', subjectTags: '', teacherName: '林老师', weeklyHours: 5, blockPreference: 'single', roomName: 'A101',
  };
  const second = {
    id: 'row-2', sourceSheetId: 'sheet-2', sourceSheet: '八年级', sourceRow: 2, parseSource: 'ai',
    grade: '八年级', className: '2班', subjectName: '数学', subjectCategory: 'main', subjectTags: '', teacherName: '王老师', weeklyHours: 4, blockPreference: 'double', roomName: 'B201',
  };
  controller.state.rosterImport = {
    ...createTimetablePlannerState().rosterImport,
    open: true,
    step: 'review',
    source: 'mixed',
    draftRows: [first, second],
    allDraftRows: [first, second],
    sheetReviews: [
      { id: 'sheet-1', name: '七年级', selected: true, status: 'included', rowCount: 1, parseSource: 'local' },
      { id: 'sheet-2', name: '八年级', selected: true, status: 'included', rowCount: 1, parseSource: 'ai' },
    ],
    parseSummary: { format: 'xlsx', sheetCount: 2, includedSheetCount: 2, includedSheetNames: ['七年级', '八年级'], localRowCount: 1, aiRowCount: 1 },
  };
  controller.readRosterReviewRows = () => controller.state.rosterImport.draftRows;
  controller.render = () => {};

  controller.state.rosterImport.draftRows[1] = { ...second, teacherName: '王老师（已复核）' };
  assert.equal(controller.toggleRosterSheet('sheet-2', false), true);
  assert.equal(controller.state.rosterImport.draftRows.length, 1);
  assert.equal(controller.state.rosterImport.stats.planCount, 1);
  assert.equal(controller.state.rosterImport.parseSummary.includedSheetCount, 1);
  assert.equal(controller.state.rosterImport.source, 'local');

  assert.equal(controller.toggleRosterSheet('sheet-2', true), true);
  assert.equal(controller.state.rosterImport.draftRows.length, 2);
  assert.equal(controller.state.rosterImport.draftRows.find(row => row.id === 'row-2').teacherName, '王老师（已复核）');
  assert.equal(controller.state.rosterImport.stats.planCount, 2);
  assert.equal(controller.state.rosterImport.parseSummary.aiRowCount, 1);
  assert.equal(controller.state.rosterImport.source, 'mixed');
});

test('timetable roster review returns to import choices and resumes without losing edited or excluded rows', () => {
  const controller = new TimetablePlannerController();
  const selected = {
    id: 'row-selected', sourceSheetId: 'sheet-1', sourceSheet: '任课数据', sourceRow: 2, parseSource: 'local',
    grade: '七年级', className: '1班', subjectName: '语文', subjectCategory: 'main', subjectTags: '', teacherName: '林老师', weeklyHours: 5, blockPreference: 'single', roomName: 'A101',
  };
  const excluded = {
    id: 'row-excluded', sourceSheetId: 'sheet-2', sourceSheet: '备用表', sourceRow: 3, parseSource: 'local',
    grade: '八年级', className: '2班', subjectName: '数学', subjectCategory: 'main', subjectTags: '', teacherName: '王老师', weeklyHours: 4, blockPreference: 'single', roomName: 'B201',
  };
  controller.state.rosterImport = {
    ...createTimetablePlannerState().rosterImport,
    open: true,
    step: 'review',
    source: 'local',
    draftRows: [selected],
    allDraftRows: [selected, excluded],
    sheetReviews: [
      { id: 'sheet-1', name: '任课数据', selected: true, status: 'included', rowCount: 1, parseSource: 'local' },
      { id: 'sheet-2', name: '备用表', selected: false, status: 'included', rowCount: 1, parseSource: 'local' },
    ],
  };
  controller.readRosterReviewRows = () => [{ ...selected, teacherName: '林老师（已复核）' }];
  controller.render = () => {};

  assert.equal(controller.returnToRosterImportInput(), true);
  assert.equal(controller.state.rosterImport.step, 'input');
  assert.equal(controller.state.rosterImport.draftRows[0].teacherName, '林老师（已复核）');
  assert.equal(controller.state.rosterImport.allDraftRows.length, 2);
  assert.equal(controller.state.rosterImport.allDraftRows.find(row => row.id === 'row-excluded').teacherName, '王老师');

  assert.equal(controller.resumeRosterReview(), true);
  assert.equal(controller.state.rosterImport.step, 'review');
  assert.equal(controller.state.rosterImport.draftRows[0].teacherName, '林老师（已复核）');
});

test('timetable roster text append merges provenance, preserves duplicates as warnings and locates the first new row', async () => {
  const controller = new TimetablePlannerController();
  const originalFetch = globalThis.fetch;
  const located = [];
  const existing = {
    id: 'existing-1', sourceSheetId: 'sheet-1', sourceSheet: '任课数据', sourceRow: 2, parseSource: 'local',
    grade: '七年级', className: '1班', subjectName: '语文', subjectCategory: 'main', subjectTags: '', teacherName: '林老师', weeklyHours: 5, blockPreference: 'single', roomName: 'A101',
  };
  controller.state.rosterImport = {
    ...createTimetablePlannerState().rosterImport,
    open: true,
    step: 'review',
    source: 'local',
    draftRows: [existing],
    allDraftRows: [existing],
    sheetReviews: [{ id: 'sheet-1', name: '任课数据', selected: true, status: 'included', rowCount: 1, parseSource: 'local' }],
    parseSummary: { format: 'xlsx', sheetCount: 1, includedSheetCount: 1, localRowCount: 1, aiRowCount: 0, aiAttempted: false, aiCallCount: 0 },
  };
  controller.readRosterReviewRows = () => controller.state.rosterImport.draftRows;
  controller.render = () => {};
  controller.locateRosterIssue = rowId => {
    located.push(rowId);
    return true;
  };
  globalThis.fetch = async (_url, options = {}) => {
    assert.deepEqual(JSON.parse(options.body), { text: '追加两行' });
    return timetableApiResponse({
      source: 'mixed',
      draftRows: [{
        id: 'server-duplicate', sourceRow: 1, parseSource: 'ai',
        grade: '七年级', className: '1班', subjectName: '语文', subjectCategory: 'main', subjectTags: '', teacherName: '林老师', weeklyHours: 5, blockPreference: 'single', roomName: 'A101',
      }, {
        id: 'server-new', sourceRow: 2, parseSource: 'local',
        grade: '八年级', className: '2班', subjectName: '数学', subjectCategory: 'main', subjectTags: '', teacherName: '王老师', weeklyHours: 4, blockPreference: 'single', roomName: 'B201',
      }],
      warnings: ['追加文本包含一条智能辅助解析结果。'],
      parseSummary: { format: 'text', sheetCount: 0, includedSheetCount: 0, localRowCount: 1, aiRowCount: 1, aiAttempted: true, aiCallCount: 1 },
    });
  };

  try {
    controller.openRosterAppendDialog();
    controller.updateRosterAppendText('追加两行');
    assert.equal(await controller.appendRosterReviewRows(), true);
    const review = controller.state.rosterImport;
    assert.equal(review.draftRows.length, 3);
    assert.equal(review.allDraftRows.length, 3);
    assert.equal(review.source, 'mixed');
    assert.equal(review.parseSummary.format, 'xlsx');
    assert.equal(review.parseSummary.sheetCount, 1);
    assert.equal(review.parseSummary.localRowCount, 2);
    assert.equal(review.parseSummary.aiRowCount, 1);
    assert.equal(review.parseSummary.aiCallCount, 1);
    assert.equal(review.hasBlockingIssues, false);
    assert.ok(review.warnings.some(message => message.includes('存在重复任课')));
    assert.ok(review.warnings.some(message => message.includes('智能辅助解析')));
    const appendedRows = review.draftRows.slice(1);
    const duplicateIssue = appendedRows[0].issues.find(issue => issue.code === 'duplicate_roster');
    assert.equal(duplicateIssue.duplicateOfRowId, existing.id);
    assert.equal(duplicateIssue.duplicateOfReviewRow, 1);
    assert.ok(appendedRows.every(row => row.sourceSheet === '追加文本' && !row.sourceSheetId));
    assert.ok(appendedRows.every(row => !['server-duplicate', 'server-new'].includes(row.id)));
    assert.equal(new Set(review.draftRows.map(row => row.id)).size, 3);
    assert.equal(review.appendDialog.open, false);
    assert.equal(review.appendDialog.text, '');
    assert.deepEqual(review.appendDialog.lastSummary, { added: 2, review: 1 });
    assert.equal(review.importReport.summary.total, 3);
    assert.deepEqual(located, [appendedRows[0].id]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable roster append keeps text and rows on failure and ignores a late response after close', async () => {
  const controller = new TimetablePlannerController();
  const originalFetch = globalThis.fetch;
  const existing = {
    id: 'existing-1', parseSource: 'local', grade: '七年级', className: '1班', subjectName: '语文', subjectCategory: 'main', subjectTags: '', teacherName: '林老师', weeklyHours: 5, blockPreference: 'single', roomName: '',
  };
  controller.state.rosterImport = {
    ...createTimetablePlannerState().rosterImport,
    open: true,
    step: 'review',
    source: 'local',
    draftRows: [existing],
    allDraftRows: [existing],
  };
  controller.readRosterReviewRows = () => controller.state.rosterImport.draftRows;
  controller.render = () => {};

  try {
    controller.openRosterAppendDialog();
    controller.updateRosterAppendText('无法解析的追加文本');
    globalThis.fetch = async () => timetableApiResponse({ reason: 'invalid' }, { ok: false, status: 400, error: '追加解析失败' });
    assert.equal(await controller.appendRosterReviewRows(), false);
    assert.equal(controller.state.rosterImport.draftRows.length, 1);
    assert.equal(controller.state.rosterImport.appendDialog.open, true);
    assert.equal(controller.state.rosterImport.appendDialog.text, '无法解析的追加文本');
    assert.match(controller.state.rosterImport.appendDialog.error, /追加解析失败/);

    let releaseResponse;
    globalThis.fetch = async () => new Promise(resolve => { releaseResponse = resolve; });
    controller.updateRosterAppendText('迟到响应');
    const pending = controller.appendRosterReviewRows();
    controller.closeRosterAppendDialog();
    releaseResponse(timetableApiResponse({
      source: 'local',
      draftRows: [{ id: 'late', grade: '九年级', className: '9班', subjectName: '物理', teacherName: '迟到老师', weeklyHours: 2 }],
      warnings: [],
      parseSummary: { localRowCount: 1, aiRowCount: 0, aiAttempted: false, aiCallCount: 0 },
    }));
    assert.equal(await pending, false);
    assert.equal(controller.state.rosterImport.draftRows.length, 1);
    assert.equal(controller.state.rosterImport.appendDialog.open, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable roster import shows a loading state while parsing before review', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    rosterImport: {
      open: true,
      step: 'input',
      mode: 'file',
      fileName: '教师配置排课数据.xlsx',
      text: '',
      loading: true,
      phaseText: '读取并解析任课文件中...',
      phaseTone: '',
    },
  }));

  assert.match(html, /id="tt-roster-import-dialog"/);
  assert.match(html, /data-lucide="loader-2" class="tt-spin"/);
  assert.match(html, /data-roster-import-submit="file" disabled/);
  assert.match(html, /data-roster-import-submit="text" disabled/);
  assert.match(html, />解析中<\/span>/);
  assert.match(html, /tt-roster-import-process/);
  assert.match(html, /读取并解析任课文件中/);
  assert.match(html, /id="tt-roster-import-file"[^>]*disabled/);
  assert.match(html, /id="tt-roster-import-text"[^>]*disabled/);
  assert.match(html, /id="tt-fill-roster-sample"[^>]*disabled/);
  assert.match(html, /id="tt-start-empty-roster-review"[^>]*disabled/);
  assert.doesNotMatch(html, /data-roster-import-mode="file"/);

  const textHtml = renderWorkbench(sampleWorkbenchState({
    rosterImport: {
      open: true,
      step: 'input',
      mode: 'text',
      fileName: '',
      text: '八年级2班体育钱老师每周3节',
      loading: true,
      phaseText: '解析任课文本中...',
      phaseTone: '',
    },
  }));
  assert.match(textHtml, /解析任课文本中/);
  assert.match(textHtml, /data-roster-import-submit="text" disabled/);
});

test('timetable roster import controller exposes modal workflow methods and bindings', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const stateSource = await readFile(new URL('state.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(stateSource, /rosterImport:\s*{/);
  assert.match(controllerSource, /openRosterImport\(/);
  assert.match(controllerSource, /closeRosterImport\(/);
  assert.match(controllerSource, /setRosterImportMode\(/);
  assert.match(controllerSource, /selectRosterImportFile\(/);
  assert.match(controllerSource, /previewRosterImport\(/);
  assert.match(controllerSource, /phaseText:\s*mode\s*===\s*'file'\s*\?\s*'读取并解析任课文件中\.\.\.'/);
  assert.match(controllerSource, /startEmptyRosterReview\(/);
  assert.match(controllerSource, /openRosterEditor\(/);
  assert.match(controllerSource, /updateRosterReviewField\(/);
  assert.match(controllerSource, /returnToRosterImportInput\(/);
  assert.match(controllerSource, /resumeRosterReview\(/);
  assert.match(controllerSource, /openRosterAppendDialog\(/);
  assert.match(controllerSource, /closeRosterAppendDialog\(/);
  assert.match(controllerSource, /updateRosterAppendText\(/);
  assert.match(controllerSource, /appendRosterReviewRows\(/);
  assert.match(controllerSource, /deleteRosterReviewRow\(/);
  assert.match(controllerSource, /toggleRosterSheet\(/);
  assert.match(controllerSource, /toggleRosterIssueList\(/);
  assert.match(controllerSource, /locateRosterIssue\(/);
  assert.match(controllerSource, /openRosterIssueEditor\(/);
  assert.match(controllerSource, /closeRosterIssueEditor\(/);
  assert.match(controllerSource, /getRosterIssueEditorNavigation\(/);
  assert.match(controllerSource, /openAdjacentRosterIssue\(/);
  assert.match(controllerSource, /applyRosterIssueEditor\(/);
  assert.match(controllerSource, /applyRosterIssueQuickFix\(/);
  assert.match(controllerSource, /confirmRosterImport\(/);
  assert.match(controllerSource, /new FormData\(\)/);
  assert.match(controllerSource, /#tt-roster-import-text/);
  assert.match(stateSource, /issueEditor:\s*null/);
  assert.match(stateSource, /appendDialog:\s*\{/);
  assert.match(interactionSource, /data-roster-import-trigger/);
  assert.match(interactionSource, /#tt-reopen-roster-import/);
  assert.match(interactionSource, /#tt-edit-roster/);
  assert.match(interactionSource, /\[data-roster-import-submit\]/);
  assert.match(interactionSource, /#tt-start-empty-roster-review/);
  assert.match(interactionSource, /#tt-confirm-roster-import/);
  assert.match(interactionSource, /#tt-back-roster-import/);
  assert.match(interactionSource, /#tt-resume-roster-review/);
  assert.match(interactionSource, /#tt-open-roster-append/);
  assert.match(interactionSource, /#tt-submit-roster-append/);
  assert.match(interactionSource, /#tt-cancel-roster-import/);
  assert.match(interactionSource, /#tt-roster-import-file/);
  assert.match(interactionSource, /\[data-roster-field\]/);
  assert.match(interactionSource, /data-roster-sheet-toggle/);
  assert.match(interactionSource, /\[data-roster-delete-row\]/);
  assert.match(interactionSource, /\[data-roster-toggle-issues\]/);
  assert.match(interactionSource, /\[data-roster-edit-issue-row\]/);
  assert.match(interactionSource, /#tt-save-roster-issue-editor/);
  assert.match(interactionSource, /#tt-roster-issue-prev/);
  assert.match(interactionSource, /#tt-roster-issue-next/);
  assert.match(interactionSource, /rosterIssueSaveMode/);
  assert.match(interactionSource, /#tt-roster-issue-locate-original/);
  assert.match(interactionSource, /\[data-roster-issue-quick-fix\]/);
  assert.match(interactionSource, /\[data-roster-jump-row\]/);
  assert.match(interactionSource, /#tt-add-roster-review-row/);
  assert.doesNotMatch(interactionSource, /#tt-append-roster-rows/);
  assert.match(styles, /\.tt-dialog-overlay/);
  assert.match(styles, /\.tt-roster-import-dialog/);
  assert.match(styles, /\.tt-roster-issue-editor-dialog/);
  assert.match(styles, /\.tt-roster-append-dialog/);
  assert.match(styles, /\.tt-roster-import-options\s*{[\s\S]*grid-template-columns:\s*minmax\(0,\s*0\.95fr\)\s*minmax\(0,\s*1\.25fr\)\s*minmax\(0,\s*0\.9fr\);/);
  assert.match(styles, /\.tt-roster-import-option\s*{[\s\S]*display:\s*grid;[\s\S]*grid-template-rows:\s*auto minmax\(140px,\s*1fr\) auto;[\s\S]*align-content:\s*stretch;[\s\S]*height:\s*100%;[\s\S]*background:\s*var\(--tt-bg-elevated\);/);
  assert.match(styles, /\.tt-roster-import-option-body\s*{[\s\S]*display:\s*grid;[\s\S]*min-height:\s*140px;[\s\S]*align-items:\s*stretch;/);
  assert.match(styles, /\.tt-roster-import-option \.tt-import-dropzone\s*{[\s\S]*min-height:\s*140px;[\s\S]*height:\s*100%;[\s\S]*align-content:\s*center;/);
  assert.match(styles, /\.tt-roster-import-option \.tt-import-text\s*{[\s\S]*min-height:\s*140px;[\s\S]*max-height:\s*140px;[\s\S]*height:\s*140px;[\s\S]*resize:\s*none;/);
  assert.match(styles, /\.tt-roster-import-option-actions\s*{[\s\S]*display:\s*flex;[\s\S]*align-items:\s*center;[\s\S]*min-height:\s*40px;[\s\S]*margin-top:\s*auto;/);
  assert.match(styles, /\.tt-roster-import-option-actions--full \.tt-btn\s*{[\s\S]*width:\s*100%;[\s\S]*justify-content:\s*center;/);
  assert.match(styles, /\.tt-roster-import-manual-preview\s*{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[\s\S]*align-content:\s*center;[\s\S]*min-height:\s*140px;[\s\S]*height:\s*100%;/);
  assert.doesNotMatch(styles, /\.tt-import-mode-tabs\s*{/);
  assert.match(styles, /\.tt-roster-import-dialog--review\s*\{[\s\S]*--tt-dialog-width:\s*1600px;[\s\S]*width:\s*min\(var\(--tt-dialog-width\),\s*calc\(100vw - 24px\)\);[\s\S]*max-width:\s*calc\(100vw - 24px\);/);
  assert.match(styles, /\.tt-roster-review-wrap\s*\{[^}]*overflow:\s*clip;[^}]*max-width:\s*100%;/);
  assert.match(styles, /\.tt-roster-review-table\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*table-layout:\s*fixed;/);
  assert.match(styles, /\.tt-roster-col-row-number\s*\{[^}]*width:\s*48px;/);
  assert.match(styles, /\.tt-roster-col-issue\s*\{[^}]*width:\s*52px;/);
  assert.match(styles, /\.tt-roster-col-action\s*\{[^}]*width:\s*48px;/);
  assert.match(styles, /\.tt-roster-review-table th,[\s\S]*\.tt-roster-review-table td\s*\{[\s\S]*text-align:\s*center;/);
  assert.match(styles, /\.tt-roster-review-table \.tt-roster-review-field\s*\{[\s\S]*text-align:\s*center;[\s\S]*text-align-last:\s*center;/);
  assert.match(styles, /\.tt-roster-review-field\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/);
  assert.match(styles, /\.tt-roster-review-table th:first-child,[\s\S]*\.tt-roster-review-table td\[data-label="行号"\],[\s\S]*\.tt-roster-review-table td\[data-label="周课时"\],[\s\S]*\.tt-roster-review-table td\[data-label="连堂"\],[\s\S]*\.tt-roster-review-table td\[data-label="问题"\],[\s\S]*\.tt-roster-review-table td\[data-label="操作"\]\s*\{[\s\S]*text-align:\s*center;/);
  assert.match(styles, /\.tt-roster-review-issue\s*\{[\s\S]*text-align:\s*center;/);
  assert.doesNotMatch(styles, /\.tt-roster-review-table th:first-child\s*\{[^}]*left:\s*0;/);
  assert.doesNotMatch(styles, /\.tt-roster-review-table th:nth-child\(13\)\s*\{[^}]*right:/);
  assert.doesNotMatch(styles, /\.tt-roster-review-table th:nth-child\(14\)\s*\{[^}]*right:/);
  assert.doesNotMatch(styles, /\.tt-roster-review-table td\[data-label="(?:行号|问题|操作)"\]\s*\{[^}]*position:\s*sticky;/);
  assert.match(styles, /\.tt-roster-sheet-options\s*{[\s\S]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(220px,\s*1fr\)\);/);
  assert.match(styles, /\.tt-roster-block-help\s*{[\s\S]*position:\s*relative;[\s\S]*display:\s*inline-flex;/);
  assert.match(styles, /\.tt-roster-block-help-trigger\s*{[\s\S]*cursor:\s*help;/);
  assert.match(styles, /\.tt-roster-block-help-popover\s*{[\s\S]*position:\s*absolute;[\s\S]*background:\s*#0f172a;[\s\S]*color:\s*var\(--tt-text-secondary\);[\s\S]*font-size:\s*0\.74rem;[\s\S]*font-weight:\s*600;[\s\S]*opacity:\s*0;[\s\S]*visibility:\s*hidden;/);
  assert.match(styles, /\.tt-roster-block-help-popover b\s*{[\s\S]*color:\s*var\(--tt-text\);[\s\S]*font-weight:\s*700;/);
  assert.match(styles, /\.tt-roster-block-help-popover em\s*{[\s\S]*display:\s*block;[\s\S]*color:\s*var\(--tt-text-secondary\);[\s\S]*font-style:\s*normal;[\s\S]*font-weight:\s*600;/);
  assert.match(styles, /body\.light-mode \.tt-roster-block-help-popover\s*{[\s\S]*background:\s*#ffffff;/);
  assert.match(styles, /\.tt-roster-block-help:hover \.tt-roster-block-help-popover,[\s\S]*\.tt-roster-block-help:focus-within \.tt-roster-block-help-popover\s*{[\s\S]*opacity:\s*1;[\s\S]*visibility:\s*visible;/);
  assert.match(styles, /\.tt-roster-review-row--error/);
  assert.match(styles, /\.tt-roster-review-row--duplicate:not\(\.tt-roster-review-row--error\) td\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--tt-danger\) 5%, transparent\);/);
  assert.match(styles, /\.tt-roster-review-row--duplicate:not\(\.tt-roster-review-row--error\) td:first-child\s*\{[^}]*box-shadow:\s*inset 3px 0 0/);
  assert.match(styles, /\.tt-roster-review-issue--duplicate\s*\{[\s\S]*color:\s*var\(--tt-danger\);[\s\S]*cursor:\s*pointer;/);
  assert.match(styles, /\.tt-roster-review-row--focused/);
  assert.match(styles, /\.tt-roster-review-actions\s*\{[^}]*position:\s*sticky;/);
  assert.match(styles, /\.tt-roster-append-dialog \.tt-import-text\s*\{[^}]*min-height:\s*180px;/);
  assert.match(styles, /\.tt-roster-issue-edit/);
  assert.match(styles, /\.tt-roster-issue-editor-progress/);
  assert.match(styles, /@media \(max-width:\s*1279px\)[\s\S]*\.tt-roster-review-table colgroup,[\s\S]*\.tt-roster-review-table thead\s*\{[\s\S]*display:\s*none;/);
  assert.match(styles, /@media \(max-width:\s*1279px\)[\s\S]*\.tt-roster-review-table tr\s*\{[\s\S]*display:\s*grid;/);
  assert.match(styles, /@media \(max-width:\s*1279px\)[\s\S]*\.tt-roster-review-table td\s*\{[\s\S]*grid-template-columns:\s*76px minmax\(0,\s*1fr\);/);
  // 已删除 .tt-rule-review-dialog CSS 断言（旧弹窗已废弃，使用 constraint dialog 替代）
  assert.match(styles, /\.tt-roster-import-dialog/);
  assert.match(styles, /\.tt-roster-issue-editor-dialog/);
  assert.match(styles, /\.tt-period-time-dialog/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-roster-import-dialog/);
});

test('timetable roster metadata fields use native single-select controls', async () => {
  const [viewSource, controllerSource, stateSource, interactionSource, styles] = await Promise.all([
    readFile(new URL('view.js', moduleRoot), 'utf8'),
    readFile(new URL('controller.js', moduleRoot), 'utf8'),
    readFile(new URL('state.js', moduleRoot), 'utf8'),
    readFile(new URL('grid-interactions.js', moduleRoot), 'utf8'),
    readFile(stylePath, 'utf8'),
  ]);

  assert.match(viewSource, /function renderRosterMetadataControl\(row = {}, field = ''\)/);
  assert.match(viewSource, /<select class="tt-roster-review-field" data-roster-field="\$\{escapeAttr\(field\)\}"/);
  assert.match(viewSource, /<option value="" \$\{selectedValue \? '' : 'selected'\}>未选择<\/option>/);
  assert.match(viewSource, /config\.options\.map\(option => `\s*<option value="\$\{escapeAttr\(option\.value\)\}"/);
  assert.match(viewSource, /importedValue \? `<option value="\$\{escapeAttr\(importedValue\)\}" selected>/);
  assert.doesNotMatch(
    [viewSource, controllerSource, stateSource, interactionSource, styles].join('\n'),
    /metadataPicker|toggleRosterMetadataPicker|setRosterMetadataOption|closeRosterMetadataPicker|data-roster-metadata|tt-roster-metadata/,
  );
});

test('timetable roster issue locator scrolls to row and focuses the field', () => {
  const controller = new TimetablePlannerController();
  const calls = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = () => 1;
  globalThis.clearTimeout = () => {};
  const field = {
    focus(options) {
      calls.push(['focus', options]);
    },
  };
  const row = {
    classList: {
      add(name) { calls.push(['add', name]); },
      remove(name) { calls.push(['remove', name]); },
    },
    scrollIntoView(options) {
      calls.push(['scroll', options]);
    },
    querySelector(selector) {
      calls.push(['fieldSelector', selector]);
      return selector === '[data-roster-field="blockPreference"]' ? field : null;
    },
  };
  controller.state.container = {
    querySelector(selector) {
      calls.push(['rowSelector', selector]);
      return selector === '[data-roster-review-row="draft_1"]' ? row : null;
    },
  };

  try {
    assert.equal(controller.locateRosterIssue('draft_1', 'blockPreference'), true);
    assert.deepEqual(calls.find(call => call[0] === 'scroll')?.[1], { block: 'center', inline: 'nearest', behavior: 'smooth' });
    assert.deepEqual(calls.find(call => call[0] === 'focus')?.[1], { preventScroll: true });
    assert.ok(calls.some(call => call[0] === 'add' && call[1] === 'tt-roster-review-row--focused'));
    assert.equal(controller.locateRosterIssue('missing', 'blockPreference'), false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('timetable roster issue editor quick fix saves a row and recalculates issues', () => {
  const controller = new TimetablePlannerController();
  let renderCount = 0;
  controller.render = () => {
    renderCount += 1;
  };
  const analyzed = controller.analyzeRosterDraftRows([{
    id: 'draft_odd_double',
    sourceRow: 12,
    sourceSheet: '任课数据',
    grade: '八年级',
    className: 'G8-2班',
    subjectName: '物理',
    subjectCategory: 'main',
    subjectTags: '',
    teacherName: '程远航',
    weeklyHours: '3',
    blockPreference: 'double',
    roomName: '',
  }]);
  controller.state.rosterImport = {
    ...controller.state.rosterImport,
    open: true,
    step: 'review',
    draftRows: analyzed.draftRows,
    stats: analyzed.stats,
    warnings: analyzed.warnings,
    issues: analyzed.issues,
    hasBlockingIssues: analyzed.hasBlockingIssues,
    issueListExpanded: true,
  };

  assert.equal(analyzed.stats.issueCount, 1);
  assert.equal(controller.openRosterIssueEditor('draft_odd_double', 'blockPreference'), true);
  assert.equal(controller.state.rosterImport.issueEditor.rowId, 'draft_odd_double');
  assert.equal(controller.closeRosterIssueEditor(), true);
  assert.equal(controller.state.rosterImport.draftRows.length, 1);
  assert.equal(controller.openRosterIssueEditor('draft_odd_double', 'blockPreference'), true);
  assert.equal(controller.applyRosterIssueQuickFix('mixed'), true);
  assert.equal(controller.state.rosterImport.issueEditor.draft.blockPreference, 'mixed');
  assert.equal(controller.applyRosterIssueEditor(), true);

  const saved = controller.state.rosterImport.draftRows.find(row => row.id === 'draft_odd_double');
  assert.equal(saved.blockPreference, 'mixed');
  assert.equal(saved.weeklyHours, '3');
  assert.equal(controller.state.rosterImport.issueEditor, null);
  assert.equal(controller.state.rosterImport.stats.issueCount, 0);
  assert.equal(controller.state.rosterImport.issues.length, 0);
  assert.ok(renderCount >= 4);
});

test('timetable roster issue editor navigates issues and saves into the next issue', () => {
  const controller = new TimetablePlannerController();
  let renderCount = 0;
  controller.render = () => {
    renderCount += 1;
  };
  const analyzed = controller.analyzeRosterDraftRows([{
    id: 'draft_physics',
    sourceRow: 12,
    sourceSheet: '任课数据',
    grade: '八年级',
    className: 'G8-2班',
    subjectName: '物理',
    subjectCategory: 'main',
    subjectTags: '',
    teacherName: '程远航',
    weeklyHours: '3',
    blockPreference: 'double',
    roomName: '',
  }, {
    id: 'draft_chem',
    sourceRow: 13,
    sourceSheet: '任课数据',
    grade: '九年级',
    className: 'G9-1班',
    subjectName: '化学',
    subjectCategory: 'lab',
    subjectTags: '',
    teacherName: '丁子航',
    weeklyHours: '5',
    blockPreference: 'double',
    roomName: '化学实验室',
  }]);
  controller.state.rosterImport = {
    ...controller.state.rosterImport,
    open: true,
    step: 'review',
    draftRows: analyzed.draftRows,
    stats: analyzed.stats,
    warnings: analyzed.warnings,
    issues: analyzed.issues,
    hasBlockingIssues: analyzed.hasBlockingIssues,
    issueListExpanded: true,
  };

  assert.equal(analyzed.stats.issueCount, 2);
  assert.equal(controller.openRosterIssueEditor('draft_physics', 'blockPreference'), true);
  assert.deepEqual(controller.getRosterIssueEditorNavigation(), {
    index: 0,
    total: 2,
    previous: null,
    next: analyzed.issues[1],
  });
  assert.equal(controller.applyRosterIssueQuickFix('mixed'), true);
  assert.equal(controller.openAdjacentRosterIssue('next'), true);
  assert.equal(controller.state.rosterImport.issueEditor.rowId, 'draft_chem');
  assert.equal(controller.state.rosterImport.draftRows.find(row => row.id === 'draft_physics').blockPreference, 'double');
  assert.equal(controller.openAdjacentRosterIssue('previous'), true);
  assert.equal(controller.state.rosterImport.issueEditor.rowId, 'draft_physics');

  assert.equal(controller.applyRosterIssueQuickFix('mixed'), true);
  assert.equal(controller.applyRosterIssueEditor({ advance: true }), true);
  assert.equal(controller.state.rosterImport.draftRows.find(row => row.id === 'draft_physics').blockPreference, 'mixed');
  assert.equal(controller.state.rosterImport.stats.issueCount, 1);
  assert.equal(controller.state.rosterImport.issueEditor.rowId, 'draft_chem');

  assert.equal(controller.applyRosterIssueEditor({ advance: true }), true);
  assert.equal(controller.state.rosterImport.stats.issueCount, 1);
  assert.equal(controller.state.rosterImport.issueEditor.rowId, 'draft_chem');

  assert.equal(controller.applyRosterIssueQuickFix('single'), true);
  assert.equal(controller.applyRosterIssueEditor({ advance: true }), true);
  assert.equal(controller.state.rosterImport.issueEditor, null);
  assert.equal(controller.state.rosterImport.stats.issueCount, 0);
  assert.equal(controller.state.rosterImport.issues.length, 0);
  assert.ok(renderCount >= 8);
});

test('timetable dialogs expand to review content on desktop and stay constrained on mobile', async () => {
  const styles = await readFile(stylePath, 'utf8');

  // 已删除 .tt-rule-review-dialog CSS 断言（旧弹窗已废弃，使用 constraint dialog 替代）
  assert.match(styles, /\.tt-roster-import-dialog,\s*[\s\S]*\.tt-period-time-dialog,\s*[\s\S]*\.tt-publish-dialog,\s*[\s\S]*\.tt-publication-history-dialog\s*{[\s\S]*width:\s*min\(var\(--tt-dialog-width,\s*720px\),\s*calc\(100vw - 48px\)\);[\s\S]*max-width:\s*calc\(100vw - 48px\);[\s\S]*max-height:\s*min\(var\(--tt-dialog-max-height,\s*860px\),\s*calc\(100vh - 48px\)\);[\s\S]*overflow:\s*auto;[\s\S]*box-shadow:\s*0 24px 60px rgba\(2,\s*6,\s*23,\s*0\.38\);/);
  assert.match(styles, /\.tt-roster-import-dialog\s*{[\s\S]*--tt-dialog-width:\s*1120px;/);
  assert.match(styles, /\.tt-roster-import-dialog--review\s*\{[\s\S]*--tt-dialog-width:\s*1600px;[\s\S]*width:\s*min\(var\(--tt-dialog-width\),\s*calc\(100vw - 24px\)\);[\s\S]*max-width:\s*calc\(100vw - 24px\);/);
  assert.match(styles, /\.tt-period-time-dialog\s*{[\s\S]*--tt-dialog-width:\s*960px;[\s\S]*--tt-dialog-max-height:\s*820px;/);
  assert.match(styles, /\.tt-publish-dialog\s*{[\s\S]*--tt-dialog-width:\s*640px;[\s\S]*--tt-dialog-max-height:\s*760px;/);
  assert.match(styles, /\.tt-publication-history-dialog\s*{[\s\S]*--tt-dialog-width:\s*920px;[\s\S]*--tt-dialog-max-height:\s*820px;/);
  assert.match(styles, /\.tt-roster-review-wrap\s*\{[^}]*overflow:\s*clip;[^}]*max-width:\s*100%;/);
  assert.match(styles, /\.tt-period-time-review\s*{[\s\S]*overflow:\s*auto;[\s\S]*max-width:\s*100%;[\s\S]*min-height:\s*0;/);
  // 已删除响应式 CSS 中对 .tt-rule-review-dialog 的断言
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-roster-import-dialog,[\s\S]*\.tt-period-time-dialog,[\s\S]*\.tt-publish-dialog,[\s\S]*\.tt-publication-history-dialog\s*{[\s\S]*width:\s*100%;[\s\S]*min-width:\s*0;[\s\S]*max-width:\s*100%;/);
});

test('timetable roster import only restores meaningful drafts when the modal is reopened', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};

  controller.state.rosterImport = {
    ...controller.state.rosterImport,
    open: true,
    step: 'input',
    mode: 'text',
    text: '',
    fileName: '',
    draftRows: [],
  };
  controller.closeRosterImport();
  controller.openRosterImport('text');
  assert.equal(controller.state.rosterImport.open, true);
  assert.equal(controller.state.rosterImport.step, 'input');
  assert.equal(controller.state.rosterImport.mode, 'file');
  assert.equal(controller.state.rosterImport.text, '');

  controller.state.rosterImport = {
    ...controller.state.rosterImport,
    open: true,
    step: 'input',
    mode: 'text',
    text: 'G7,1,Math,Teacher,4',
    fileName: '',
    draftRows: [],
  };
  controller.closeRosterImport();
  assert.equal(controller.state.rosterImport.open, false);
  assert.equal(controller.state.rosterImport.text, 'G7,1,Math,Teacher,4');
  controller.openRosterImport('file');
  assert.equal(controller.state.rosterImport.open, true);
  assert.equal(controller.state.rosterImport.step, 'input');
  assert.equal(controller.state.rosterImport.mode, 'text');
  assert.equal(controller.state.rosterImport.text, 'G7,1,Math,Teacher,4');

  controller.state.rosterImport = {
    ...controller.state.rosterImport,
    open: true,
    step: 'input',
    mode: 'text',
    text: '   ',
    fileName: '',
    draftRows: [],
  };
  controller.closeRosterImport();
  controller.openRosterImport('text');
  assert.equal(controller.state.rosterImport.step, 'input');
  assert.equal(controller.state.rosterImport.mode, 'file');
  assert.equal(controller.state.rosterImport.text, '');

  controller.selectRosterImportFile({ name: 'roster.xlsx' });
  controller.closeRosterImport();
  controller.openRosterImport('text');
  assert.equal(controller.state.rosterImport.step, 'input');
  assert.equal(controller.state.rosterImport.mode, 'file');
  assert.equal(controller.state.rosterImport.fileName, 'roster.xlsx');

  controller.rosterImportFile = null;
  controller.state.rosterImport = {
    ...controller.state.rosterImport,
    open: false,
    step: 'input',
    mode: 'file',
    text: '',
    fileName: 'stale-roster.xlsx',
    draftRows: [],
  };
  controller.openRosterImport('file');
  assert.equal(controller.state.rosterImport.step, 'input');
  assert.equal(controller.state.rosterImport.mode, 'file');
  assert.equal(controller.state.rosterImport.fileName, '');

  controller.startEmptyRosterReview();
  assert.equal(controller.state.rosterImport.step, 'review');
  assert.equal(controller.state.rosterImport.draftRows.length, 1);
  controller.closeRosterImport();
  controller.openRosterImport('file');
  assert.equal(controller.state.rosterImport.step, 'input');
  assert.equal(controller.state.rosterImport.mode, 'file');
  assert.deepEqual(controller.state.rosterImport.draftRows, []);

  controller.state.rosterImport = {
    ...controller.state.rosterImport,
    open: true,
    step: 'review',
    mode: 'file',
    fileName: 'roster.xlsx',
    draftRows: [{ id: 'draft_1', className: '1', subjectName: 'Math', teacherName: 'Teacher', weeklyHours: '4' }],
    stats: { planCount: 1 },
    warnings: ['warn'],
    issues: [],
  };
  controller.closeRosterImport();
  assert.equal(controller.state.rosterImport.open, false);
  controller.openRosterImport('text');
  assert.equal(controller.state.rosterImport.open, true);
  assert.equal(controller.state.rosterImport.step, 'review');
  assert.equal(controller.state.rosterImport.mode, 'file');
  assert.equal(controller.state.rosterImport.draftRows.length, 1);

  controller.state.rosterImport = {
    ...controller.state.rosterImport,
    open: true,
    step: 'review',
    mode: 'file',
    fileName: '',
    draftRows: [{ ...controller.emptyRosterDraftRow(), className: '1班' }],
    stats: { planCount: 1 },
    warnings: [],
    issues: [],
  };
  controller.closeRosterImport();
  controller.openRosterImport('file');
  assert.equal(controller.state.rosterImport.step, 'review');
  assert.equal(controller.state.rosterImport.mode, 'file');
  assert.equal(controller.state.rosterImport.draftRows.length, 1);
  assert.equal(controller.state.rosterImport.draftRows[0].className, '1班');

  controller.resetRosterImport();
  controller.openRosterImport('text');
  assert.equal(controller.state.rosterImport.open, true);
  assert.equal(controller.state.rosterImport.step, 'input');
  assert.equal(controller.state.rosterImport.mode, 'file');
  assert.deepEqual(controller.state.rosterImport.draftRows, []);
});

test('timetable 智能 rules support Excel file upload and rich preview metadata', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const stateSource = await readFile(new URL('state.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  // New design: pending rules from an xlsx parse appear as inline cards
  const state = sampleWorkbenchState({
    ruleInput: { text: '', fileName: 'constraints.xlsx', loading: false },
    pendingRules: [{
      id: 'draft-1',
      rawText: 'Math should prefer Monday period 2',
      type: 'subject_preferred_periods',
      targetType: 'subject',
      targetName: 'Math',
      targetId: 'math',
      slots: ['1-2'],
      priority: 'soft',
      status: 'effective',
      confidence: 0.92,
      description: 'Prefer period',
      warnings: [],
    }, {
      id: 'draft-2',
      rawText: 'Balance teacher workload',
      type: 'teacher_load_balance',
      targetType: 'global',
      targetName: 'All teachers',
      slots: [],
      priority: 'soft',
      status: 'suggestion',
      confidence: 0.78,
      description: 'Suggestion only',
      warnings: [],
    }],
    expandedRuleId: null,
  });
  const html = renderWorkbench(state);

  // Inline card-based UI renders pending cards and input area
  assert.match(html, /id="tt-open-rule-review"/);
  assert.doesNotMatch(html, /id="tt-rule-input-area"/);
  assert.doesNotMatch(html, /id="tt-pending-rules"/);
  assert.doesNotMatch(html, /data-rule-card="draft-1"/);
  assert.doesNotMatch(html, /data-rule-card="draft-2"/);
  assert.doesNotMatch(html, /data-rule-accept="draft-1"/);
  assert.doesNotMatch(html, /data-rule-reject="draft-1"/);
  assert.doesNotMatch(html, /data-rule-expand="draft-1"/);
  assert.doesNotMatch(html, /id="tt-rule-accept-all"/);
  assert.doesNotMatch(html, /id="tt-rule-reject-all"/);
  assert.doesNotMatch(html, /subject_preferred_periods/);
  assert.doesNotMatch(html, /teacher_load_balance/);
  // File input supports xlsx
  assert.doesNotMatch(html, /id="tt-rule-input-file"/);
  // State shape includes ruleInput and pendingRules
  assert.match(stateSource, /ruleInput:\s*{/);
  assert.match(stateSource, /pendingRules:\s*\[/);
  // Controller exposes card-based methods plus legacy dialog methods
  assert.match(controllerSource, /parseRulesInline\(/);
  assert.match(controllerSource, /acceptRule\(/);
  assert.match(controllerSource, /rejectRule\(/);
  assert.match(controllerSource, /acceptAllRules\(/);
  assert.match(controllerSource, /submitClarifyingAnswers\(/);
  assert.match(controllerSource, /rejectAllRules\(/);
  assert.match(controllerSource, /selectRuleInputFile\(/);
  assert.match(controllerSource, /expandRuleCard\(/);
  assert.match(controllerSource, /\/rules\/normalize/);
  // Interactions bind the new card buttons
  assert.doesNotMatch(interactionSource, /#tt-rule-parse-btn/);
  assert.doesNotMatch(interactionSource, /#tt-rule-input-file/);
  assert.doesNotMatch(interactionSource, /#tt-rule-manual-add-btn/);
  assert.doesNotMatch(interactionSource, /\[data-rule-accept\]/);
  assert.doesNotMatch(interactionSource, /\[data-rule-reject\]/);
  assert.doesNotMatch(interactionSource, /\[data-rule-expand\]/);
  assert.match(interactionSource, /#tt-open-rule-review/);
  assert.match(interactionSource, /#tt-rule-review-file/);
  assert.match(interactionSource, /#tt-rule-review-parse/);
  assert.match(interactionSource, /submit-rule-clarification/);
  assert.match(interactionSource, /submitClarifyingAnswers\(/);
  assert.match(interactionSource, /\[data-saved-rule-delete\]/);
  assert.doesNotMatch(interactionSource, /#tt-open-bulk-rule-review/);
  assert.match(styles, /\.tt-empty-card/);
  assert.match(styles, /\.tt-rule-entry/);
  assert.match(styles, /\.tt-rules-setup-card/);
  assert.match(styles, /\.tt-rules-setup-body/);
  assert.doesNotMatch(styles, /\.tt-rule-entry-card/);
  // 已删除 .tt-rule-review-dialog 样式断言（旧弹窗已废弃）
});

test('timetable constraint dialog keeps parsed drafts in the current review flow', async () => {
  const pendingRules = [{
    id: 'draft-1',
    origin: 'user_input',
    rawText: 'All teachers should be balanced',
    type: 'teacher_load_balance',
    targetType: 'global',
    targetName: 'All teachers',
    slots: [],
    priority: 'soft',
    status: 'suggestion',
    confidence: 0.7,
    description: 'Suggestion only',
    warnings: [],
  }, {
    id: 'draft-2',
    origin: 'user_input',
    rawText: 'Math should prefer Monday period 2',
    type: 'subject_preferred_periods',
    targetType: 'subject',
    targetName: 'Math',
    targetId: 'math',
    slots: ['1-2'],
    priority: 'soft',
    status: 'effective',
    confidence: 0.9,
    description: 'Prefer period',
    warnings: [],
  }];
  const state = sampleWorkbenchState({
    pendingRules: [],
    expandedRuleId: null,
    ruleInput: { text: '', fileName: '', loading: false },
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'file',
      fileName: 'constraints.xlsx',
      inputType: 'xlsx_constraints',
      draftRows: pendingRules,
      warnings: ['Unknown object ignored'],
      unsupportedItems: [],
      contextStats: { rowCount: 2 },
    },
  });

  const dialogState = {
    ...state,
    constraintDialog: { open: true },
    smartWorkbench: { open: false },
  };
  const html = renderWorkbench(dialogState);
  const sidebar = html.match(/<aside class="tt-sidebar">([\s\S]*?)<\/aside>\s*<section class="tt-schedule-panel">/)?.[1] || '';

  assert.match(sidebar, /id="tt-open-rule-review"/);
  assert.match(html, /data-constraint-dialog-overlay/);
  assert.match(html, /tt-constraint-dialog/);
  assert.match(html, /tt-requirement-workbench/);
  assert.match(html, /解析结果/);
  assert.match(html, /来自你的输入 2 条 · 系统补充 0 条/);
  assert.match(html, /落地结果/);
  assert.match(html, /All teachers should be balanced/);
  assert.match(html, /Math should prefer Monday period 2/);
  assert.match(html, /data-action="apply-constraints"/);
  assert.doesNotMatch(html, /已识别约束/);
  assert.doesNotMatch(html, /data-smart-workbench-root/);
  assert.doesNotMatch(sidebar, /id="tt-pending-rules"/);
  assert.doesNotMatch(sidebar, /data-rule-card="draft-1"/);
  assert.doesNotMatch(sidebar, /data-rule-card="draft-2"/);
  assert.doesNotMatch(sidebar, /待确认 \(2\)/);
  assert.doesNotMatch(html, /id="tt-rule-review-dialog"/);
  assert.doesNotMatch(html, /data-rule-review-row="draft-1"/);
  assert.doesNotMatch(html, /data-rule-review-row="draft-2"/);

  // Controller sends existing drafts to the constraint dialog.
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.ruleReview = {
    open: false,
    step: 'input',
    mode: 'file',
    draftRows: pendingRules,
    warnings: [],
  };
  controller.openRuleReview('file');
  assert.equal(controller.state.constraintDialog.open, true);
  assert.equal(controller.state.smartWorkbench.open, false);
  assert.equal(controller.state.ruleReview.inputMode, 'file');
  assert.equal(controller.state.ruleReview.draftRows.length, 2);
});

test('timetable rule review shows all-teacher limit targets instead of an unmatched teacher dropdown', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'ready',
      busy: true,
    }),
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      text: 'dialog text',
      originalText: 'original constraint',
      advancedOpen: true,
      draftRows: [{
        id: 'all-teachers-limit',
        rawText: '每位教师每天授课量尽量均衡，单日不超过4节',
        type: 'teacher_daily_limit',
        targetType: 'teacher',
        targetName: '全部教师',
        targetId: '',
        limit: 4,
        priority: 'soft',
        status: 'effective',
        confidence: 0.9,
        warnings: [],
      }],
      warnings: [],
    },
  }));

  assert.match(html, /data-constraint-id="all-teachers-limit"/);
  assert.match(html, /全部教师/);
  assert.match(html, /每位教师每天授课量尽量均衡/);
  assert.doesNotMatch(html, /data-rule-target-select/);
  assert.doesNotMatch(html, /<option value="">未选择<\/option>/);
});

test('timetable smart rules sidebar opens the constraint dialog', async () => {
  const dialogSource = await readFile(new URL('view-constraint-dialog.js', moduleRoot), 'utf8');
  const componentSource = await readFile(new URL('view-constraint-dialog-components.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');
  const state = sampleWorkbenchState({
    pendingRules: [],
    expandedRuleId: null,
    ruleInput: { text: '', fileName: '', loading: false },
  });
  const html = renderWorkbench(state);
  const sidebar = html.match(/<aside class="tt-sidebar">([\s\S]*?)<\/aside>\s*<section class="tt-schedule-panel">/)?.[1] || '';

  // Inline input area is present in the sidebar rules section
  assert.match(sidebar, /id="tt-open-rule-review"/);
  assert.doesNotMatch(sidebar, /id="tt-rule-input-area"/);
  assert.doesNotMatch(sidebar, /id="tt-rule-input-text"/);
  assert.doesNotMatch(sidebar, /id="tt-rule-input-file"/);
  assert.doesNotMatch(sidebar, /id="tt-rule-parse-btn"/);
  assert.doesNotMatch(sidebar, /id="tt-rule-manual-add-btn"/);
  // Example chips are rendered
  assert.doesNotMatch(sidebar, /data-rule-example=/);
  // No obsolete dialog or card entry pattern
  assert.doesNotMatch(sidebar, /id="tt-open-bulk-rule-review"/);
  assert.doesNotMatch(sidebar, /id="tt-add-lock"/);
  assert.doesNotMatch(sidebar, /tt-lock-list/);
  assert.match(sidebar, /class="[^"]*tt-rule-stack[^"]*tt-rules-setup-card[^"]*"/);
  assert.match(sidebar, /class="[^"]*tt-rules-setup-body[^"]*"/);
  assert.match(sidebar, /class="[^"]*tt-empty-card[^"]*tt-roster-entry[^"]*tt-rule-entry[^"]*"/);
  assert.match(sidebar, /智能约束助手/);
  assert.match(sidebar, /自然语言需求理解、复核与落地/);
  assert.match(sidebar, /tt-smart-helper-flow/);
  assert.match(sidebar, /理解需求[\s\S]*补充信息[\s\S]*生成规则[\s\S]*发布校验/);
  assert.match(sidebar, /可应用/);
  assert.match(sidebar, /需复核/);
  assert.match(sidebar, /已处理/);
  assert.match(styles, /\.tt-rules-setup-card\s+\.tt-smart-helper-flow\s*{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.tt-rules-setup-card\s+\.tt-smart-helper-flow\s+span\s*{[\s\S]*justify-content:\s*center/);
  assert.match(styles, /\.tt-rules-setup-card\s+\.tt-smart-helper-metrics\s*{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(styles, /\.tt-rules-setup-card\s+\.tt-smart-helper-flow\s+b,[\s\S]*\.tt-rules-setup-card\s+\.tt-smart-helper-metrics\s+b\s*{[\s\S]*text-overflow:\s*clip/);
  assert.doesNotMatch(sidebar, /需注意/);
  assert.doesNotMatch(sidebar, /class="[^"]*tt-rule-summary[^"]*"/);
  assert.doesNotMatch(sidebar, /tt-rule-entry-card/);
  // No dialog rendered when no pending rules and no open state
  assert.doesNotMatch(html, /id="tt-rule-review-dialog"/);
  // The current dialog owns text, file, manual, preview, edit, and AI actions.
  assert.match(dialogSource, /data-action="switch-constraint-mode"/);
  assert.match(dialogSource, /id="tt-manual-rule-type"/);
  assert.match(dialogSource, /data-action="add-manual-constraint"/);
  assert.match(dialogSource, /data-action="parse-constraints"/);
  assert.match(dialogSource, /data-action="apply-constraints"/);
  const dialogControllerSource = await readFile(new URL('controller-constraint-dialog.js', moduleRoot), 'utf8');
  assert.match(dialogControllerSource, /requestTimetable\('\/rules\/parse'/);
  assert.doesNotMatch(dialogControllerSource, /requestTimetable\('\/rule-review\/parse'/);
  assert.match(componentSource, /data-action="edit-constraint"/);
  assert.match(componentSource, /data-action="delete-constraint"/);

  // Opening directly to manual mode uses the constraint dialog.
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.openRuleReview('manual');
  assert.equal(controller.state.constraintDialog.open, true);
  assert.equal(controller.state.smartWorkbench.open, false);
  assert.equal(controller.state.ruleReview.inputMode, 'manual');
});

test('timetable smart rules no longer keep the old inline sidebar renderer', async () => {
  const viewSource = await readFile(new URL('view.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.doesNotMatch(viewSource, /function renderRuleInputArea/);
  assert.doesNotMatch(viewSource, /function renderRuleCard\(/);
  assert.doesNotMatch(viewSource, /function renderSavedRuleList/);
  assert.doesNotMatch(viewSource, /function renderRulePreview/);
  assert.doesNotMatch(styles, /(?:^|\n)\.tt-rule-input-area\s*\{/);
  assert.doesNotMatch(styles, /(?:^|\n)\.tt-pending-rules\s*\{/);
  assert.doesNotMatch(styles, /(?:^|\n)\.tt-saved-rules\s*\{/);
});

test('timetable rule type labels are centralized while preserving planner wording', async () => {
  const viewSource = await readFile(new URL('view.js', moduleRoot), 'utf8');
  const dialogControllerSource = await readFile(new URL('controller-constraint-dialog-advanced.js', moduleRoot), 'utf8');

  assert.equal(RULE_TYPE_LABELS.subject_morning, '上午优先');
  assert.equal(plannerRuleTypeLabel('subject_morning'), '课程上午优先');
  assert.equal(plannerRuleTypeLabel('locked_slot'), '锁定课节');
  assert.equal(plannerRuleTypeLabel('teacher_load_balance'), '教师负载均衡（仅建议）');
  assert.equal(plannerRuleTypeLabel('unknown_rule'), 'unknown_rule');
  assert.doesNotMatch(viewSource, /const RULE_TYPE_LABELS/);
  assert.match(viewSource, /plannerRuleTypeLabel\s+as\s+ruleTypeLabel/);
  assert.doesNotMatch(dialogControllerSource, /const RULE_TYPE_LABELS/);
  assert.match(dialogControllerSource, /RULE_TYPE_LABELS/);
});

test('timetable constraint dialog shows parse progress feedback', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const dialogBaseStyles = await readFile(constraintDialogStylePath, 'utf8');
  const dialogAdvancedStyles = await readFile(constraintDialogAdvancedStylePath, 'utf8');
  const dialogStyles = `${dialogBaseStyles}\n${dialogAdvancedStyles}`;
  const initialHtml = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'input',
      mode: 'text',
      text: '',
      draftRows: [],
      warnings: [],
      loading: false,
    },
  }));
  const fileHtml = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'input',
      mode: 'file',
      fileName: '智能-rules.xlsx',
      text: 'Math prefers morning',
      draftRows: [],
      warnings: [],
      loading: true,
      phase: 'parse_file',
      phaseText: '智能解析约束中...',
    },
  }));
  const aiReviewHtml = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'input',
      mode: 'text',
      text: '数学尽量上午',
      draftRows: [],
      warnings: [],
      loading: true,
      parsing: true,
      parseProgress: 45,
      phaseText: '正在让 AI 复审识别结果...',
    },
  }));
  const reviewHtml = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      text: '数学尽量上午',
      draftRows: [{
        id: 'draft-review',
        rawText: '数学尽量上午',
        type: 'subject_morning',
        targetType: 'subject',
        targetName: 'Math',
        targetId: 'math',
        status: 'effective',
        priority: 'soft',
        warnings: [],
      }],
      warnings: [],
      loading: false,
    },
  }));

  assert.match(initialHtml, /tt-constraint-flow-current/);
  assert.match(initialHtml, /当前进度/);
  assert.match(initialHtml, /data-constraint-flow-current-index[^>]*>1 \/ 4</);
  assert.doesNotMatch(initialHtml, /data-constraint-flow-current-title/);
  assert.match(initialHtml, /等待输入文本、文件或手动补充/);
  assert.match(initialHtml, /data-flow-step="input"[^>]*aria-current="step"/);
  assert.match(initialHtml, /tt-constraint-flow-step[^"]*is-current[\s\S]*?输入需求/);
  assert.match(fileHtml, /data-constraint-dialog-overlay/);
  assert.match(fileHtml, /智能-rules\.xlsx/);
  assert.match(fileHtml, /data-action="parse-constraints"[^>]*disabled/);
  assert.match(fileHtml, /data-lucide="loader-2"[^>]*class="tt-spin"/);
  assert.match(fileHtml, /正在解析/);
  assert.match(fileHtml, /data-flow-step="understand"[^>]*aria-current="step"/);
  assert.match(fileHtml, /data-constraint-flow-current-index[^>]*>2 \/ 4</);
  assert.match(fileHtml, /data-flow-step="input"[^>]*is-complete/);
  assert.match(fileHtml, /tt-constraint-flow[^>]*--tt-flow-percent:/);
  assert.match(fileHtml, /data-action="switch-constraint-mode"[\s\S]*?disabled/);
  assert.match(fileHtml, /id="tt-constraint-file-input"[^>]*disabled/);
  assert.doesNotMatch(fileHtml, /data-smart-workbench-root/);
  assert.doesNotMatch(fileHtml, /id="tt-rule-review-dialog"/);
  assert.match(aiReviewHtml, /data-flow-step="understand"[^>]*aria-current="step"/);
  assert.match(aiReviewHtml, /正在让 AI 复审识别结果/);
  assert.match(reviewHtml, /data-flow-step="review"[^>]*aria-current="step"/);
  assert.match(reviewHtml, /data-constraint-flow-current-index[^>]*>3 \/ 4</);
  assert.match(reviewHtml, /data-flow-step="understand"[^>]*is-complete/);
  assert.match(reviewHtml, /请检查已理解需求和落地结果/);

  const textHtml = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'input',
      mode: 'text',
      text: '数学尽量上午',
      draftRows: [],
      warnings: [],
      loading: true,
      phaseText: '生成复核行中...',
    },
  }));

  assert.match(textHtml, /tt-parsing-status/);
  assert.match(textHtml, /生成复核行中\.\.\./);
  assert.match(textHtml, /data-lucide="loader-2"[^>]*class="tt-spin"/);

  assert.match(styles, /\.tt-spin\s*{/);
  assert.match(styles, /@keyframes\s+tt-spin/);
  assert.match(dialogStyles, /\.tt-parsing-status\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-input-tabs\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-intake-panel\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-mode-row\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-form-surface\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-dialog-actions \.tt-btn\s*{[^}]*white-space:\s*nowrap/);
  assert.match(dialogStyles, /\.tt-requirement-choice-chip\s*{/);
  assert.doesNotMatch(dialogStyles, /\.tt-constraint-command-row\s*{/);
  assert.doesNotMatch(dialogStyles, /\.tt-quick-examples\s*{/);
  assert.doesNotMatch(dialogStyles, /\.tt-constraint-intake-note\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-flow-current\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-flow::before\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-flow::after\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-flow-step\.is-current\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-flow-step\.is-complete\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-flow-step\.is-upcoming\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-flow-current\s+small\s*{/);
  assert.match(dialogStyles, /\.tt-tab-btn\s+span\s*{[^}]*white-space:\s*nowrap/);
  assert.match(dialogStyles, /\.tt-tab-btn\.is-active\s*{[^}]*background:\s*var\(--tt-bg-panel\)/);
  assert.doesNotMatch(dialogStyles, /\.tt-tab-btn\.is-active\s*{[^}]*background:\s*var\(--tt-primary\)/);
});

test('timetable constraint AI chat is embedded inside the constraint dialog', async () => {
  const controllerSource = await readFile(new URL('../public/js/tools/timetable/controller.js', import.meta.url), 'utf8');
  const dialogControllerSource = await readFile(new URL('../public/js/tools/timetable/controller-constraint-dialog-advanced.js', import.meta.url), 'utf8');
  const interactionSource = await readFile(new URL('../public/js/tools/timetable/grid-interactions.js', import.meta.url), 'utf8');
  const indexHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const dialogBaseStyles = await readFile(constraintDialogStylePath, 'utf8');
  const dialogAdvancedStyles = await readFile(constraintDialogAdvancedStylePath, 'utf8');
  const dialogStyles = `${dialogBaseStyles}\n${dialogAdvancedStyles}`;

  const state = sampleWorkbenchState({
    constraintDialog: createConstraintDialogState({
      open: true,
      aiChat: {
        active: true,
        loading: false,
        conversationId: 'conv_test',
        messages: [{
          role: 'assistant',
          content: '缺少节次会导致规则不能执行，请补充可用节次。',
        }, {
          role: 'user',
          content: '请解释这些约束',
        }],
        suggestedPrompts: ['检查这些约束是否有冲突'],
      },
    }),
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'file',
      draftRows: [{
        id: 'draft-1',
        rawText: 'Math Teacher daily limit',
        type: 'teacher_daily_limit',
        targetType: 'teacher',
        targetName: 'Math Teacher',
        targetId: 't_math',
        value: 4,
        slots: [],
        priority: 'soft',
        status: 'effective',
        confidence: 0.9,
        description: 'Daily limit',
        warnings: [],
      }],
      missingInfo: [{
        id: 'missing-1',
        message: '缺少明确节次，请补充后再生效。',
        relatedRuleIds: ['draft-1'],
      }],
      needReview: [],
      unsupportedItems: [],
      warnings: ['H-004 和 H-005 涉及连堂保护，无法直接映射。'],
      loading: false,
    },
  });
  const html = renderWorkbench(state);

  assert.doesNotThrow(() => new TimetablePlannerController());
  assert.equal(typeof TimetablePlannerController.prototype.startConstraintConversation, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.sendConstraintChatMessage, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.closeConstraintChat, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.updateConstraintChatInput, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.applyConstraintChatPreview, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.startConstraintAIChat, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.sendConstraintAIMessage, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.closeConstraintAIChat, 'function');
  assert.match(controllerSource, /constraintDialogAdvancedMethods/);
  assert.match(dialogControllerSource, /startConstraintAIChat/);
  assert.match(dialogControllerSource, /sendConstraintAIMessage/);
  assert.match(html, /tt-constraint-dialog--with-ai/);
  assert.match(html, /tt-ai-chat-panel/);
  assert.match(html, /tt-constraint-dialog-body/);
  assert.match(html, /tt-constraint-dialog-body--ai/);
  assert.match(html, /tt-ai-chat-toolbar/);
  assert.match(html, /tt-ai-chat-stream/);
  assert.match(html, /tt-ai-message-icon/);
  assert.match(html, /AI 约束优化助手/);
  assert.match(html, /缺少节次会导致规则不能执行/);
  assert.match(html, /请解释这些约束/);
  assert.match(html, /data-action="use-ai-prompt"/);
  assert.match(html, /data-action="send-ai-message"/);
  assert.match(html, /data-action="close-ai-chat"/);
  assert.doesNotMatch(html, /tt-smart-workbench/);
  assert.doesNotMatch(html, /tt-constraint-chat-dock/);
  assert.doesNotMatch(html, /tt-constraint-chat-overlay/);
  assert.doesNotMatch(html, /当前办理事项/);
  assert.doesNotMatch(html, /AI 帮我处理/);
  assert.match(interactionSource, /start-ai-chat/);
  assert.match(interactionSource, /send-ai-message/);
  assert.match(interactionSource, /close-ai-chat/);
  assert.match(interactionSource, /use-ai-prompt/);
  assert.match(indexHtml, /css\/timetable-chat\.css/);
  assert.match(indexHtml, /css\/timetable-constraint-dialog\.css/);
  assert.match(indexHtml, /css\/timetable-constraint-dialog-advanced\.css/);
  assert.doesNotMatch(indexHtml, /css\/timetable-smart-workbench\.css/);
  assert.match(dialogStyles, /\.tt-constraint-dialog\s*{/);
  assert.match(dialogStyles, /--tt-dialog-width:\s*780px/);
  assert.match(dialogStyles, /\.tt-constraint-dialog-body\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-dialog--with-ai\s*{[\s\S]*--tt-dialog-width:\s*960px/);
  assert.match(dialogStyles, /@media\s*\(max-width:\s*640px\)[\s\S]*\.tt-constraint-dialog/);
  assert.match(dialogStyles, /\.tt-ai-chat-panel\s*{[\s\S]*background:\s*var\(--tt-bg-input\)/);
  assert.match(dialogStyles, /\.tt-ai-chat-messages\s*{[\s\S]*max-height:\s*min\(420px,\s*48vh\)/);
  assert.match(dialogStyles, /\.tt-ai-message-icon\s*{[\s\S]*border-radius:\s*var\(--tt-radius-sm\)/);
  assert.doesNotMatch(dialogStyles, /\.tt-ai-chat-panel\s*{[\s\S]*height:\s*600px/);
  assert.doesNotMatch(dialogStyles, /\.tt-suggested-prompt-chip:hover\s*{[\s\S]*box-shadow:\s*0 0 20px/);
});

test('timetable hides the constraint chat dock until a conversation is open', () => {
  const html = renderWorkbench(sampleWorkbenchState());

  assert.doesNotMatch(html, /tt-constraint-chat-dock/);
  assert.doesNotMatch(html, /当前办理事项/);
});

test('timetable rule review parse renders the opened input state before progress updates', async () => {
  const controllerSource = await readFile(new URL('../public/js/tools/timetable/controller.js', import.meta.url), 'utf8');
  const parseRulesSource = extractMethodSource(controllerSource, 'parseRules');

  assert.match(
    parseRulesSource,
    /this\.state\.ruleReview\s*=\s*{[\s\S]*?open:\s*true,[\s\S]*?text,[\s\S]*?};\s*this\.renderRuleReviewSurface\(\);\s*try\s*{/
  );
});

test('timetable rule review updates the constraint dialog without old modal renderers', async () => {
  const controllerSource = await readFile(new URL('../public/js/tools/timetable/controller.js', import.meta.url), 'utf8');
  const closedHtml = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      advancedOpen: false,
      draftRows: [{
        id: 'lazy-row',
        rawText: 'Math should be in the morning',
        type: 'subject_morning',
        targetType: 'subject',
        targetId: 'math',
        targetName: 'Math',
        status: 'effective',
        priority: 'soft',
        warnings: [],
      }],
      warnings: [],
    },
  }));

  assert.match(controllerSource, /renderRuleReviewSurface\(\)\s*{/);
  assert.match(controllerSource, /this\.state\.constraintDialog\s*=\s*{/);
  assert.match(controllerSource, /open:\s*true/);
  assert.match(controllerSource, /this\.state\.smartWorkbench\s*=\s*{[\s\S]*open:\s*false/);
  assert.doesNotMatch(controllerSource, /renderRuleReviewDialog\(this\.state\)/);
  assert.match(closedHtml, /data-constraint-dialog-overlay/);
  assert.match(closedHtml, /data-constraint-id="lazy-row"/);
  assert.match(closedHtml, /Math should be in the morning/);
  assert.doesNotMatch(closedHtml, /id="tt-rule-review-table"/);
  assert.doesNotMatch(closedHtml, /data-rule-review-row="lazy-row"/);
});

test('timetable constraint dialog locks inputs while rules are being written', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'review',
    }),
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'file',
      fileName: '智能-rules.xlsx',
      inputType: 'xlsx_constraints',
      draftRows: [{
        id: 'draft-1',
        rawText: 'Math should prefer Monday period 2',
        type: 'subject_preferred_periods',
        targetType: 'subject',
        targetName: 'Math',
        targetId: 'math',
        slots: ['1-2'],
        priority: 'soft',
        status: 'effective',
        confidence: 0.92,
        description: 'Prefer period',
        warnings: [],
      }],
      contextStats: { rowCount: 1 },
      warnings: [],
      advancedOpen: true,
      loading: true,
      parsing: true,
      phase: 'saving',
      phaseText: '写入项目中...',
    },
  }));

  assert.match(html, /正在解析/);
  assert.match(html, /data-flow-step="apply"[^>]*aria-current="step"/);
  assert.match(html, /data-constraint-flow-current-index[^>]*>4 \/ 4</);
  assert.match(html, /data-flow-step="review"[^>]*is-complete/);
  assert.match(html, /正在写入项目规则和模型设置/);
  assert.match(html, /data-action="parse-constraints"[^>]*disabled/);
  assert.match(html, /data-action="apply-constraints"[^>]*disabled/);
  assert.match(html, /data-lucide="loader-2"[^>]*class="tt-spin"/);
  assert.match(html, /data-action="switch-constraint-mode"[\s\S]*?disabled/);
  assert.match(html, /data-constraint-id="draft-1"/);
  assert.doesNotMatch(html, /data-action="smart-workbench-preview-rules"/);
  assert.doesNotMatch(html, /data-rule-review-field="rawText"/);
});

test('timetable constraint dialog explains card warnings and source text separately', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const dialogStyles = await readFile(constraintDialogStylePath, 'utf8');
  const html = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'ready',
    }),
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'file',
      fileName: '智能-rules.xlsx',
      inputType: 'xlsx_constraints',
      draftRows: [{
        id: 'draft-source-1',
        origin: 'user_input',
        source: '智能约束建议',
        sourceRow: 1,
        rawText: '同一位教师同一时间只能给一个班上课。',
        type: 'subject_morning',
        targetType: 'subject',
        targetName: '语文',
        targetId: 'chinese',
        slots: [],
        priority: 'soft',
        status: 'effective',
        confidence: 0.9,
        description: '语文尽量安排在上午',
        warnings: [],
      }, {
        id: 'draft-source-2',
        origin: 'user_input',
        source: '智能约束建议',
        sourceRow: 4,
        rawText: '混合课程连堂块不可拆。',
        type: 'block_protection',
        targetType: 'subject',
        targetName: '化学',
        slots: [],
        priority: 'soft',
        status: 'suggestion',
        confidence: 0.75,
        description: '建议项，仅供复核',
        warnings: ['当前版本只能预览这类建议'],
      }],
      contextStats: { rowCount: 2 },
      warnings: [
        '第1条（同一教师不冲突）是排课系统的基础规则，已自动处理，无需额外约束。',
        '第4条（混合课程连堂块不可拆）当前约束类型不支持，请人工在设计时处理。',
        '第9条（上午主科不过载）无法用现有约束精确表达，建议通过手动调整或后续优化。',
        '第17条（教师空堂紧凑）建议作为优化目标。',
      ],
      advancedOpen: true,
      loading: false,
    },
    constraintDialog: { open: true, selectedRequirementId: 'draft_req_draft-source-1' },
  }));

  assert.match(html, /data-constraint-dialog-overlay/);
  assert.match(html, /tt-requirement-workbench/);
  assert.match(html, /解析结果/);
  assert.match(html, /来自你的输入 2 条 · 系统补充 0 条/);
  assert.match(html, /落地结果/);
  assert.doesNotMatch(html, /tt-constraint-preview/);
  assert.doesNotMatch(html, /已识别约束/);
  assert.match(html, /混合课程连堂块不可拆/);
  assert.match(html, /原文：同一位教师同一时间只能给一个班上课。/);
  assert.match(html, /data-constraint-id="draft-source-1"/);
  assert.doesNotMatch(html, /data-rule-review-row="draft-source-1"/);
  assert.doesNotMatch(html, /data-rule-review-row="draft-source-2"/);

  assert.match(dialogStyles, /\.tt-constraint-source\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-warning\s*{/);
  assert.match(styles, /\.tt-rule-review-table\s*{/);
});

test('timetable smart scan renders problem details inline with beginner actions', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'review',
    }),
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'file',
      draftRows: [{
        id: 'row-1',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 't_math',
        targetName: 'Math Teacher',
        slots: [],
        status: 'needs_review',
        warnings: ['缺少明确节次，请补充后再生效。'],
      }],
      warnings: [],
    },
    constraintScan: {
      open: true,
      completed: true,
      scanning: false,
      stats: { total: 1, autoFixable: 1, completeness: 95, scanDuration: 12, checksPerformed: 5, complianceScore: 95 },
      problems: [{
        id: 'missing_slots',
        type: 'HARD',
        severity: 'urgent',
        title: '有 1 条约束还没安排具体时间',
        description: '缺少明确节次',
        count: 1,
        autoFixable: true,
        fixSuggestion: '可自动补齐 1 条已能识别的时段',
        constraints: [{ id: 'row-1', rawText: 'Math Teacher 周三下午不排课' }],
      }],
    },
    problemDetailDialog: {
      open: true,
      problem: {
        id: 'missing_slots',
        type: 'HARD',
        severity: 'urgent',
        title: '有 1 条约束还没安排具体时间',
        description: '缺少明确节次',
        count: 1,
        autoFixable: true,
        fixSuggestion: '可自动补齐 1 条已能识别的时段',
        constraints: [{ id: 'row-1', rawText: 'Math Teacher 周三下午不排课' }],
      },
    },
  }));

  assert.match(html, /data-smart-helper-overlay/);
  assert.match(html, /tt-smart-detail/);
  assert.match(html, /问题详情/);
  assert.match(html, /修正建议/);
  assert.match(html, /data-action="close-problem-detail"/);
  assert.match(html, /data-action="apply-fix"/);
  assert.match(html, /data-action="discuss-with-ai"/);
  assert.match(html, /问智能/);
  assert.doesNotMatch(html, /问AI/);
  assert.match(html, /可自动补齐 1 条已能识别的时段/);
  assert.match(html, /data-smart-detail-backdrop/);
});

test('timetable smart helper applies generated fixes to review draft rows', () => {
  const controller = new TimetablePlannerController();
  const rows = [{
    id: 'row-1',
    type: 'teacher_unavailable',
    targetType: 'teacher',
    targetId: 't_math',
    targetName: 'Math Teacher',
    slots: [],
    status: 'invalid',
    warnings: ['缺少明确节次，请补充后再生效。'],
  }, {
    id: 'row-2',
    type: 'teacher_unavailable',
    targetType: 'teacher',
    targetId: 't_math',
    targetName: 'Math Teacher',
    slots: ['1-1'],
    status: 'effective',
    warnings: [],
  }];

  const updated = controller.applyFixToConstraints(rows, {
    fixes: [{
      action: 'set_slots',
      constraintId: 'row-1',
      slots: ['3-5', '3-6', '3-7'],
    }, {
      action: 'replace_slot',
      constraintId: 'row-2',
      from: '1-1',
      to: '1-2',
    }, {
      action: 'add_constraint',
      constraint: {
        id: 'auto_teacher_daily_limit_t_math',
        type: 'teacher_daily_limit',
        targetType: 'teacher',
        targetId: 't_math',
        targetName: 'Math Teacher',
        value: 5,
        priority: 'soft',
        status: 'effective',
      },
    }],
  });

  assert.deepEqual(updated[0].slots, ['3-5', '3-6', '3-7']);
  assert.equal(updated[0].status, 'needs_review');
  assert.equal(updated[0].warnings.length, 0);
  assert.deepEqual(updated[1].slots, ['1-2']);
  assert.equal(updated[1].status, 'needs_review');
  assert.ok(updated.some(row => row.id === 'auto_teacher_daily_limit_t_math'));
});

test('timetable beginner rule cards update the underlying review draft rows', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.ruleReview = {
    open: true,
    step: 'review',
    mode: 'text',
    advancedOpen: false,
    draftRows: [{
      id: 'card-1',
      rawText: '王老师周三下午不排课',
      type: 'teacher_unavailable',
      targetType: 'teacher',
      targetId: 't_math',
      targetName: 'Math Teacher',
      slots: ['3-5'],
      priority: 'hard',
      status: 'needs_review',
      description: '教师不可排',
      warnings: [],
    }, {
      id: 'card-2',
      rawText: '体育课尽量分散',
      type: 'subject_spread',
      targetType: 'subject',
      targetId: 'pe',
      targetName: '体育',
      slots: [],
      priority: 'soft',
      status: 'needs_review',
      description: '同科分散',
      warnings: [],
    }],
    warnings: [],
  };

  controller.markRuleReviewRowEffective('card-1');
  assert.equal(controller.state.ruleReview.draftRows.find(row => row.id === 'card-1').status, 'effective');

  controller.ignoreRuleReviewRow('card-1');
  assert.equal(controller.state.ruleReview.draftRows.find(row => row.id === 'card-1').status, 'ignored');

  controller.editRuleReviewRow('card-1');
  assert.equal(controller.state.ruleReview.advancedOpen, true);
  assert.equal(controller.state.ruleReview.selectedRuleId, 'card-1');

  controller.deleteRuleReviewCard('card-2');
  assert.deepEqual(controller.state.ruleReview.draftRows.map(row => row.id), ['card-1']);
});

test('timetable smart helper asks through the existing constraint chat with problem context', async () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.setMessage = message => {
    controller.state.message = message;
  };
  controller.state.ruleReview = {
    open: true,
    step: 'review',
    draftRows: [{ id: 'row-1', type: 'teacher_unavailable', status: 'needs_review' }],
  };
  controller.state.constraintScan = {
    problems: [{
      id: 'missing_slots',
      title: '缺少节次',
      description: '王老师没说明第几节',
      fixSuggestion: '补充具体节次',
    }],
  };
  let optionsSeen = null;
  controller.startConstraintConversation = async options => {
    optionsSeen = options;
    controller.state.constraintChat = {
      open: true,
      inputText: '',
      messages: [],
      activeTaskId: options?.taskContext?.taskId || '',
    };
  };

  await controller.openAIChatFromHelper('missing_slots');

  assert.equal(controller.state.constraintChat.open, true);
  assert.equal(optionsSeen.intent, 'explain');
  assert.equal(optionsSeen.taskContext.taskId, 'missing_slots');
  assert.equal(optionsSeen.taskContext.taskType, 'missing_slots');
  assert.match(optionsSeen.taskContext.examples.join('\n'), /王老师没说明第几节/);
  assert.equal(controller.state.constraintChat.activeTaskId, 'missing_slots');
});

test('timetable smart helper interactions include detail close and problem-aware chat', async () => {
  const interactionSource = await readFile(new URL('../public/js/tools/timetable/grid-interactions.js', import.meta.url), 'utf8');

  assert.match(interactionSource, /data-smart-detail-backdrop/);
  assert.match(interactionSource, /closeProblemDetails/);
  assert.match(interactionSource, /openAIChatFromHelper\(event\.target\.closest\('\[data-problem-id\]'\)/);
});

test('timetable constraint chat preview application updates drafts only after confirmation', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.ruleReview = {
    open: true,
    step: 'review',
    draftRows: [{
      id: 'draft-1',
      type: 'teacher_unavailable',
      targetName: '王老师',
      slots: ['1-8', '1-7'],
      warnings: ['节次 1-8 不在当前排课范围内。'],
      status: 'needs_review',
    }],
  };
  controller.state.project = createDefaultTimetableProject({
    teachers: [{ id: 't_wang', name: '王老师' }],
    classes: [{ id: 'c1', name: '七年级1班' }],
    subjects: [{ id: 'math', name: '数学' }],
    lessonPlans: [],
    rules: { hardRules: {}, softRules: {} },
  });
  controller.state.constraintChat = {
    open: true,
    docked: true,
    actionPreview: {
      title: '过滤超出范围节次',
      affectedRuleIds: ['draft-1'],
      changes: [{
        ruleId: 'draft-1',
        updates: {
          slots: ['1-7'],
          warnings: [],
          status: 'effective',
        },
      }],
      requiresConfirmation: true,
    },
  };

  const savedRulesBefore = JSON.stringify(controller.state.project.rules);
  assert.deepEqual(controller.state.ruleReview.draftRows[0].slots, ['1-8', '1-7']);

  controller.applyConstraintChatPreview();

  assert.deepEqual(controller.state.ruleReview.draftRows[0].slots, ['1-7']);
  assert.equal(controller.state.ruleReview.draftRows[0].status, 'effective');
  assert.deepEqual(controller.state.ruleReview.draftRows[0].warnings, []);
  assert.equal(JSON.stringify(controller.state.project.rules), savedRulesBefore);
});

test('timetable smart scan status stays compact and completed problems join the task workbench', () => {
  const baseReview = {
    open: true,
    step: 'review',
    mode: 'file',
    draftRows: [{ id: 'row-1', type: 'teacher_unavailable', status: 'needs_review' }],
    warnings: [],
  };
  const problem = index => ({
    id: `urgent-${index}`,
    type: 'HARD',
    severity: 'urgent',
    title: `紧急问题 ${index}`,
    description: `问题 ${index}`,
    count: 1,
    autoFixable: true,
    fixSuggestion: '生成修复预览',
  });

  const errorHtml = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'review',
    }),
    ruleReview: baseReview,
    constraintScan: {
      open: true,
      scanning: false,
      error: '扫描服务暂不可用',
      problems: [],
      stats: {},
    },
  }));
  assert.match(errorHtml, /扫描服务暂不可用/);
  assert.match(errorHtml, /data-action="rescan-smart-helper"/);

  const loadingHtml = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'review',
    }),
    ruleReview: baseReview,
    constraintScan: {
      open: true,
      scanning: true,
      progress: 60,
      phase: '检查可能冲突的规则...',
      problems: [],
      stats: {},
    },
  }));
  assert.match(loadingHtml, /检查可能冲突的规则/);
  assert.match(loadingHtml, /智能助手正在检查约束/);

  const scanHtml = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'review',
    }),
    ruleReview: baseReview,
    constraintScan: {
      open: true,
      scanning: false,
      applyingAll: true,
      expandedGroups: new Set(['urgent']),
      stats: { total: 4, autoFixable: 4, completeness: 80, scanDuration: 3, checksPerformed: 5, complianceScore: 80 },
      problems: [problem(1), problem(2), problem(3), problem(4)],
    },
  }));
  assert.match(scanHtml, /智能检查完成/);
  assert.match(scanHtml, /发现 4 个问题/);
  assert.match(scanHtml, /紧急问题 1/);
  assert.match(scanHtml, /紧急问题 4/);
  assert.match(scanHtml, /data-problem-id="urgent-1"/);
  assert.match(scanHtml, /data-action="apply-fix"/);
  assert.doesNotMatch(scanHtml, /class="tt-smart-helper"/);
  assert.match(scanHtml, /data-action="apply-all-fixes"[^>]*disabled/);

  const previewHtml = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'review',
    }),
    ruleReview: baseReview,
    constraintScan: {
      open: true,
      scanning: false,
      expandedGroups: new Set(['urgent']),
      stats: { total: 4, autoFixable: 4, completeness: 80, scanDuration: 3, checksPerformed: 5, complianceScore: 80 },
      problems: [problem(1), problem(2), problem(3), problem(4)],
    },
    fixPreview: {
      open: true,
      applying: true,
      problem: problem(1),
      fix: {
        preview: { before: '修复前', after: '修复后' },
        fixes: [{ reason: '测试修复' }],
      },
    },
  }));
  assert.match(previewHtml, /应用中/);
  assert.match(previewHtml, /data-action="confirm-fix"[^>]*disabled/);
});

test('timetable rule review renders a beginner task workbench instead of raw question lists', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const ruleReview = {
      open: true,
      step: 'review',
      mode: 'text',
      inputType: 'text',
      nextAction: 'ask_user',
      activeTaskId: 'confirm_teacher_names',
      autoAcceptable: [{
        id: 'auto-1',
        origin: 'user_input',
        rawText: '数学尽量上午',
        type: 'subject_morning',
        targetName: '数学',
        targetId: 'math',
        priority: 'soft',
        status: 'effective',
        confidence: 0.93,
        description: '数学优先上午',
      }],
      needReview: [{
        id: 'review-1',
        origin: 'user_input',
        rawText: '王老师周三下午不要排',
        type: 'teacher_unavailable',
        targetName: '王老师',
        priority: 'hard',
        status: 'needs_review',
        confidence: 0.62,
        warnings: ['存在多个候选教师'],
      }],
      clarifyingQuestions: [{
        id: 'q_1',
        question: '你说的王老师是哪一位？',
        reason: '存在多个同姓教师',
        targetType: 'teacher',
        targetText: '王老师',
        options: [
          { label: '王明', value: 't_wang_ming' },
          { label: '王华', value: 't_wang_hua' },
        ],
        relatedRuleIds: ['review-1'],
      }],
      missingInfo: [{
        id: 'm_1',
        message: '你说的道法、地理、劳动是哪个课程？',
        targetType: 'subject',
        targetText: '道法、地理、劳动',
        relatedRuleIds: ['review-2'],
      }, {
        id: 'm_2',
        message: '节次 1-8、2-8 不在当前排课范围内。',
        relatedRuleIds: ['review-1'],
      }],
      conflicts: [{ level: 'blocking', message: '李老师不可排与锁定课节冲突', suggestion: '取消其中一个硬约束。', relatedRuleIds: ['lock-1'] }],
      unsupportedItems: [{ id: 'u_1', type: 'teacher_free_period_compact', targetName: '全部教师', description: '当前仅作为建议。' }],
      confidenceSummary: { high: 1, medium: 1, low: 0 },
      draftRows: [{
        id: 'auto-1',
        origin: 'user_input',
        rawText: '数学尽量上午',
        type: 'subject_morning',
        targetType: 'subject',
        targetName: '数学',
        targetId: 'math',
        priority: 'soft',
        status: 'effective',
        confidence: 0.93,
        warnings: [],
      }, {
        id: 'review-1',
        origin: 'user_input',
        rawText: '王老师周三下午不要排',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetName: '王老师',
        priority: 'hard',
        status: 'needs_review',
        confidence: 0.62,
        warnings: ['存在多个候选教师'],
      }],
      warnings: [],
  };
  const html = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'review',
    }),
    ruleReview,
  }));
  const readyHtml = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'ready',
    }),
    ruleReview,
  }));
  const conflictHtml = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'conflict',
    }),
    ruleReview,
  }));
  const unsupportedHtml = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'unsupported',
    }),
    ruleReview,
  }));
  const advancedHtml = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'review',
    }),
    ruleReview: { ...ruleReview, advancedOpen: true },
  }));

  assert.match(html, /data-constraint-dialog-overlay/);
  assert.match(html, /tt-constraint-dialog/);
  assert.match(html, /tt-requirement-workbench/);
  assert.match(html, /解析结果/);
  assert.match(html, /来自你的输入 2 条 · 系统补充 0 条/);
  assert.match(html, /落地结果/);
  assert.doesNotMatch(html, /已识别约束/);
  assert.match(html, /数学尽量上午/);
  assert.match(html, /王老师周三下午不要排/);
  assert.match(html, /存在多个候选教师/);
  assert.match(html, /data-constraint-id="review-1"/);
  assert.match(html, /data-action="edit-constraint"/);
  assert.match(html, /data-action="delete-constraint"/);
  assert.match(html, /data-action="apply-constraints"/);
  assert.doesNotMatch(html, /tt-smart-workbench/);
  assert.doesNotMatch(html, /tt-smart-task-checklist/);
  assert.doesNotMatch(html, /data-action="smart-workbench-section"/);
  assert.doesNotMatch(html, /你说的王老师是哪一位/);
  assert.doesNotMatch(html, /你说的道法、地理、劳动是哪个课程/);
  assert.doesNotMatch(html, /data-rule-clarify-question="q_1"/);
  assert.match(readyHtml, /data-action="apply-constraints"/);
  assert.match(conflictHtml, /data-constraint-dialog-overlay/);
  assert.match(unsupportedHtml, /data-constraint-dialog-overlay/);
  assert.doesNotMatch(html, /data-rule-review-row="auto-1"/);
  assert.doesNotMatch(advancedHtml, /data-rule-review-row="auto-1"/);
  assert.doesNotMatch(advancedHtml, /data-rule-review-field="rawText"/);

  const dialogStyles = await readFile(constraintDialogStylePath, 'utf8');
  assert.match(dialogStyles, /\.tt-constraint-dialog\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-card\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-actions\s*{/);
});

test('timetable constraint dialog renders manual mode without old clarify questions', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    constraintDialog: createConstraintDialogState({ open: true }),
    ruleReview: {
      open: true,
      step: 'manual',
      mode: 'manual',
      clarifyingQuestions: [{
        id: 'q_empty',
        question: 'Which all-teacher object?',
        reason: 'No valid candidate should be shown as a dropdown.',
        options: [
          { label: '', value: '' },
          { label: null, value: null },
        ],
      }],
      draftRows: [],
      warnings: [],
      unsupportedItems: [],
    },
  }));

  assert.match(html, /data-constraint-dialog-overlay/);
  assert.match(html, /id="tt-manual-rule-target"/);
  assert.match(html, /data-manual-rule-slot/);
  assert.match(html, /教师不可排/);
  assert.match(html, /课程分散安排/);
  assert.doesNotMatch(html, /id="tt-manual-target"/);
  assert.doesNotMatch(html, /id="tt-manual-time"/);
  assert.match(html, /data-action="add-manual-constraint"/);
  assert.doesNotMatch(html, /data-rule-clarify-question="q_empty"/);
  assert.doesNotMatch(html, /data-rule-question-answer="q_empty"/);
});

test('structured constraint forms use isolated responsive styles and one shared rule model', async () => {
  const dialogStyles = await readFile(constraintDialogStylePath, 'utf8');
  const componentSource = await readFile(new URL('view-constraint-dialog-components.js', moduleRoot), 'utf8');
  const advancedControllerSource = await readFile(new URL('controller-constraint-dialog-advanced.js', moduleRoot), 'utf8');

  assert.match(dialogStyles, /\.tt-constraint-rule-form\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-rule-main-fields\s*{[^}]*grid-template-columns:/s);
  assert.match(dialogStyles, /\.tt-constraint-rule-slot-grid\s*{[^}]*overflow-x:\s*auto/s);
  assert.match(dialogStyles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-constraint-rule-main-fields\s*{[^}]*grid-template-columns:\s*1fr/s);
  assert.doesNotMatch(componentSource, /EDITABLE_RULE_TYPES/);
  assert.doesNotMatch(advancedControllerSource, /RULE_TARGET_KIND|SLOT_RULE_TYPES|LIMIT_RULE_TYPES/);
});

test('timetable constraint dialog renders recognized rule cards instead of the removed report workbench', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'ready',
    }),
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      inputType: 'text',
      draftRows: [{
        id: 'rule_kept',
        origin: 'user_input',
        rawText: '数学尽量上午',
        type: 'subject_morning',
        targetType: 'subject',
        targetId: 'math',
        targetName: 'Math',
        priority: 'soft',
        status: 'effective',
        confidence: 0.93,
        warnings: [],
      }],
      autoAcceptable: [{
        id: 'rule_kept',
        origin: 'user_input',
        rawText: '数学尽量上午',
        type: 'subject_morning',
        targetId: 'math',
        targetName: 'Math',
        status: 'effective',
      }],
      needReview: [],
      unsupportedItems: [],
      warnings: [],
      conflicts: [],
      ruleReport: {
        sourceKind: 'rules',
        summary: { total: 3, kept: 1, degraded: 1, dropped: 0, review: 1 },
        entries: [{
          category: 'kept',
          source: { rowId: 'rule_kept', inputType: 'text' },
          field: 'subject_morning',
          reason: '高置信度规则，可确认后写入。',
        }, {
          category: 'degraded',
          source: { rowId: 'rule_suggestion', inputType: 'text' },
          field: 'teacher_load_balance',
          reason: '当前只能作为建议展示，不会直接写入规则。',
        }, {
          category: 'review',
          source: { rowId: 'rule_review', inputType: 'text' },
          field: 'teacher_unavailable',
          reason: '王老师需要复核后才能生效。',
        }],
        hasIssues: true,
      },
    },
  }));

  assert.match(html, /data-constraint-dialog-overlay/);
  assert.match(html, /tt-requirement-workbench/);
  assert.match(html, /解析结果/);
  assert.match(html, /来自你的输入 1 条 · 系统补充 0 条/);
  assert.match(html, /落地结果/);
  assert.doesNotMatch(html, /已识别约束/);
  assert.match(html, /数学尽量上午/);
  assert.match(html, /data-constraint-id="rule_kept"/);
  assert.match(html, /data-action="apply-constraints"/);
  assert.doesNotMatch(html, /规则报告/);
  assert.doesNotMatch(html, /当前只能作为建议展示，不会直接写入规则。/);
});

test('timetable constraint dialog disables apply when blocking conflicts exist', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'ready',
    }),
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      activeTaskId: 'ready_to_apply',
      autoAcceptable: [{
        id: 'auto-1',
        type: 'subject_morning',
        targetName: '数学',
        status: 'effective',
        confidence: 0.92,
          warnings: [],
      }],
      draftRows: [{
        id: 'auto-1',
        type: 'subject_morning',
        targetType: 'subject',
        targetName: '数学',
        status: 'effective',
        confidence: 0.92,
        warnings: [],
        hasConflict: true,
        conflicts: [{ level: 'blocking', message: '锁定课节与教师不可用冲突。' }],
      }],
      needReview: [],
      conflicts: [{ level: 'blocking', message: '锁定课节与教师不可用冲突。' }],
      warnings: [],
      unsupportedItems: [],
    },
  }));

  assert.match(html, /data-action="apply-constraints"[^>]*disabled/);
  assert.match(html, /锁定课节与教师不可用冲突/);
  assert.match(html, /tt-constraint-card--conflict/);
});

test('timetable rule review can clarify questions and request rule diagnosis', async () => {
  const calls = [];
  let clarifyBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/rules/clarify')) {
      clarifyBody = calls.at(-1).body;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              draftRows: [{
                id: 'review-1',
                type: 'teacher_unavailable',
                targetType: 'teacher',
                targetId: 't_wang_hua',
                targetName: '王华',
                slots: ['3-5'],
                priority: 'hard',
                status: 'effective',
                confidence: 0.9,
                warnings: [],
              }],
              autoAcceptable: [{ id: 'review-1', status: 'effective' }],
              needReview: [],
              warnings: [],
              unsupportedItems: [],
              nextAction: 'ready_to_apply',
            },
          };
        },
      };
    }
    if (String(url).endsWith('/rules/diagnose')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              diagnosis: {
                summary: '当前约束没有明显无解风险。',
                blockingRules: [],
                suggestedRelaxations: ['可以继续试排。'],
                questions: [],
              },
            },
          };
        },
      };
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const controller = new TimetablePlannerController();
    controller.state.project = createDefaultTimetableProject({
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [
        { id: 't_wang_ming', name: '王明', subjects: ['math'], unavailableSlots: [] },
        { id: 't_wang_hua', name: '王华', subjects: ['math'], unavailableSlots: [] },
      ],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: '数学', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_wang_hua', weeklyHours: 3 }],
    });
    controller.state.ruleReview = {
      open: true,
      step: 'review',
      mode: 'text',
      text: 'dialog text',
      originalText: 'original constraint',
      draftRows: [{
        id: 'review-1',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetName: '王老师',
        slots: ['3-5'],
        priority: 'hard',
        status: 'needs_review',
        confidence: 0.7,
        warnings: ['存在多个候选教师'],
      }],
      clarifyingQuestions: [{
        id: 'q_review-1_target',
        targetType: 'teacher',
        targetText: 'Wang',
        question: '你说的王老师是哪一位？',
        options: [{ label: '王华', value: 't_wang_hua' }],
      }],
    };
    controller.state.pendingRules = [
      { id: 'old-duplicate' },
      ...controller.state.ruleReview.draftRows,
    ];
    controller.state.container = {
      innerHTML: '',
      querySelectorAll(selector) {
        if (selector === '[data-rule-clarify-question]') {
          return [{
            dataset: { ruleClarifyQuestion: 'q_review-1_target', targetType: 'teacher', targetText: 'Wang' },
            querySelectorAll(innerSelector) {
              if (innerSelector === '[data-rule-clarify-option]') {
                return [{
                  checked: true,
                  value: 't_wang_hua',
                  dataset: { label: 'Wang Hua' },
                }];
              }
              return [];
            },
            querySelector() { return null; },
          }];
        }
        if (selector === '[data-rule-question-answer]') {
          return [{
            dataset: { ruleQuestionAnswer: 'q_review-1_target' },
            value: 't_wang_hua',
            selectedIndex: 0,
            options: [{ textContent: '王华' }],
          }];
        }
        return [];
      },
      querySelector() { return null; },
    };
    controller.render = () => {};

    await controller.submitClarifyingAnswers();
    assert.ok(calls.some(call => call.url.endsWith('/rules/clarify')));
    assert.ok(clarifyBody.project);
    assert.equal(clarifyBody.originalText, 'original constraint');
    assert.equal(clarifyBody.previousResult?.draftRows?.length, 1);
    assert.deepEqual(clarifyBody.answers, [{
      questionId: 'q_review-1_target',
      value: 't_wang_hua',
      label: 'Wang Hua',
      targetType: 'teacher',
      targetText: 'Wang',
    }]);
    assert.equal(controller.state.ruleReview.draftRows[0].targetId, 't_wang_hua');
    assert.deepEqual(controller.state.pendingRules.map(row => row.id), ['review-1']);

    await controller.diagnoseRules();
    assert.ok(calls.some(call => call.url.endsWith('/rules/diagnose')));
    assert.equal(controller.state.ruleReview.diagnosis.summary, '当前约束没有明显无解风险。');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable constraint dialog card aligns controls and helper text without the removed table', async () => {
  const dialogStyles = await readFile(constraintDialogStylePath, 'utf8');
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'file',
      fileName: '智能-rules.xlsx',
      inputType: 'xlsx_constraints',
      draftRows: [{
        id: 'draft-align-1',
        rawText: 'Music should avoid the last periods',
        type: 'subject_avoid_periods',
        targetType: 'subject',
        targetName: 'Music',
        targetId: 'music',
        slots: ['1-5', '1-6', '1-7', '2-5'],
        priority: 'soft',
        status: 'effective',
        confidence: 0.7,
        description: 'Music should be arranged before afternoon or half day',
        warnings: ['Long warning should stay in the helper row instead of moving controls'],
      }],
      contextStats: { rowCount: 1 },
      warnings: [],
      advancedOpen: true,
      loading: false,
    },
  }));

  assert.match(html, /data-constraint-dialog-overlay/);
  assert.match(html, /data-constraint-id="draft-align-1"/);
  assert.match(html, /Music should avoid the last periods/);
  assert.match(html, /Long warning should stay/);
  assert.match(html, /class="tt-constraint-actions"/);
  assert.match(html, /data-action="edit-constraint"/);
  assert.match(html, /data-action="delete-constraint"/);
  assert.doesNotMatch(html, /<colgroup class="tt-rule-review-cols">/);
  assert.doesNotMatch(html, /data-rule-review-field="slots"/);

  assert.match(dialogStyles, /\.tt-constraint-card\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-content\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-warning\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-actions\s*{/);
});

test('timetable saved smart rules remain summarized while the constraint dialog stays separate', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const project = createDefaultTimetableProject({
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [
      { id: 'math', name: 'Math', priority: 90, color: '#2563eb' },
      { id: 'pe', name: 'PE', priority: 30, color: '#22c55e' },
    ],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
    rules: {
      hardRules: {
        teacherUnavailable: { t_math: ['3-4'] },
        classUnavailable: { c1: ['5-7'] },
        lockedSlots: [{ id: 'lock_1', day: 2, period: 3, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' }],
      },
      softRules: {
        morningSubjects: ['math'],
        subjectPreferredPeriods: { math: { prefer: ['1-1'], avoid: ['5-7'], weight: 20 } },
        teacherLimits: { t_math: { daily: 3, consecutive: 2 } },
        spreadSubjects: ['pe'],
      },
    },
    schedule: null,
  });

  const savedItems = getSavedRuleItems(project);
  const summary = getRuleSummary(project);

  assert.equal(savedItems.length, 9);
  assert.equal(summary.total, 9);
  assert.ok(savedItems.some(item => item.type === 'subject_preferred_periods' && item.slots.includes('1-1')));
  assert.ok(savedItems.some(item => item.type === 'teacher_daily_limit' && item.targetName === 'Math Teacher'));
  assert.ok(savedItems.some(item => item.type === 'subject_spread' && item.targetName === 'PE'));

  // Saved rules render inline in the sidebar as a saved rule list
  const html = renderWorkbench(sampleWorkbenchState({
    project,
    pendingRules: [],
    expandedRuleId: null,
    ruleInput: { text: '', fileName: '', loading: false },
  }));
  const sidebar = html.match(/<aside class="tt-sidebar">([\s\S]*?)<\/aside>\s*<section class="tt-schedule-panel">/)?.[1] || '';

  // New card-based saved rules section
  assert.match(sidebar, /id="tt-open-rule-review"/);
  assert.match(sidebar, /tt-smart-helper-entry/);
  assert.match(sidebar, /智能约束助手/);
  assert.match(sidebar, /自然语言需求理解、复核与落地/);
  assert.match(sidebar, /tt-smart-helper-flow/);
  assert.match(sidebar, /理解需求[\s\S]*补充信息[\s\S]*生成规则[\s\S]*发布校验/);
  assert.match(sidebar, /tt-smart-helper-metrics/);
  assert.match(sidebar, /可应用/);
  assert.match(sidebar, /需复核/);
  assert.match(sidebar, /已处理/);
  assert.match(sidebar, /class="[^"]*tt-rule-stack[^"]*tt-rules-setup-card[^"]*"/);
  assert.match(sidebar, /class="[^"]*tt-empty-card[^"]*tt-roster-entry[^"]*tt-rule-entry[^"]*"/);
  assert.doesNotMatch(sidebar, /class="[^"]*tt-rule-summary[^"]*"/);
  assert.doesNotMatch(sidebar, /查看已应用约束|查看已生效约束/);
  assert.match(sidebar, /9/);
  assert.match(sidebar, /id="tt-clear-rules"/);
  assert.match(sidebar, /清空约束/);
  assert.doesNotMatch(sidebar, /id="tt-saved-rules"/);
  assert.doesNotMatch(sidebar, /data-saved-rule-delete=/);
  assert.doesNotMatch(sidebar, /data-saved-rule="/);
  // Rule type labels are visible
  assert.doesNotMatch(sidebar, /teacher_daily_limit/);
  assert.doesNotMatch(sidebar, /subject_spread/);

  const workbenchHtml = renderWorkbench(sampleWorkbenchState({
    project,
    constraintDialog: { open: true },
    smartWorkbench: { open: false },
    ruleReview: {
      open: false,
      draftRows: [],
      warnings: [],
    },
  }));

  assert.match(workbenchHtml, /data-constraint-dialog-overlay/);
  assert.match(workbenchHtml, /智能约束助手/);
  assert.match(workbenchHtml, /自然语言需求理解、复核与落地/);
  assert.match(workbenchHtml, /排课要求/);
  assert.match(workbenchHtml, /开始理解/);
  assert.match(workbenchHtml, /data-action="parse-constraints"/);
  assert.doesNotMatch(workbenchHtml, /data-smart-workbench-root/);
  assert.doesNotMatch(workbenchHtml, /data-saved-rule-delete=/);
  assert.doesNotMatch(workbenchHtml, /id="tt-saved-rule-table"/);
  assert.doesNotMatch(workbenchHtml, /id="tt-rule-review-dialog"/);
  assert.doesNotMatch(styles, /(?:^|\n)\.tt-saved-rules\s+\.tt-saved-rule-row\s*\{/);
  assert.doesNotMatch(styles, /(?:^|\n)\.tt-saved-rule-row\s*\{/);
});

test('timetable saved 智能 rules can be removed one at a time without clearing others', () => {
  const project = createDefaultTimetableProject({
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
    rules: {
      hardRules: {
        teacherUnavailable: { t_math: ['3-4', '4-5'] },
        lockedSlots: [{ id: 'lock_1', day: 2, period: 3, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' }],
      },
      softRules: {
        morningSubjects: ['math'],
        subjectPreferredPeriods: { math: { prefer: ['1-1'], avoid: ['5-7'], weight: 20 } },
      },
    },
  });

  const items = getSavedRuleItems(project);
  const teacherRule = items.find(item => item.type === 'teacher_unavailable' && item.slots.includes('3-4'));
  const preferredRule = items.find(item => item.type === 'subject_preferred_periods');
  const lockedRule = items.find(item => item.type === 'locked_slot');
  const morningRule = items.find(item => item.type === 'subject_morning');

  const withoutTeacher = removeSavedRuleById(project, teacherRule.id);
  assert.deepEqual(withoutTeacher.hardRules.teacherUnavailable.t_math, ['4-5']);

  const withoutPreferred = removeSavedRuleById({ ...project, rules: withoutTeacher }, preferredRule.id);
  assert.deepEqual(withoutPreferred.softRules.subjectPreferredPeriods.math.prefer, []);
  assert.deepEqual(withoutPreferred.softRules.subjectPreferredPeriods.math.avoid, ['5-7']);

  const withoutLocked = removeSavedRuleById({ ...project, rules: withoutPreferred }, lockedRule.id);
  assert.deepEqual(withoutLocked.hardRules.lockedSlots, []);

  const withoutMorning = removeSavedRuleById({ ...project, rules: withoutLocked }, morningRule.id);
  assert.deepEqual(withoutMorning.softRules.morningSubjects, []);
  assert.deepEqual(withoutMorning.hardRules.teacherUnavailable.t_math, ['4-5']);
});

test('timetable modal overlays do not close when the blank overlay is clicked', async () => {
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');

  assert.doesNotMatch(interactionSource, /\[data-rule-review-close\][\s\S]{0,220}closeRuleReview\(/);
  assert.doesNotMatch(interactionSource, /\[data-roster-import-close\][\s\S]{0,220}closeRosterImport\(/);
});

test('timetable Escape steps back inside the workbench instead of bubbling to the tool shell', () => {
  let stopped = false;
  let prevented = false;
  const closed = [];
  const event = {
    key: 'Escape',
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
  };
  const controller = {
    closeRestoreDialog() {
      closed.push('restore');
    },
    closePublicationHistoryDialog() {
      closed.push('history');
    },
    closePublishDialog() {
      closed.push('publish');
    },
    closePeriodTimeDialog() {
      closed.push('period');
    },
    closeRosterImport() {
      closed.push('roster');
    },
    closeRosterIssueEditor() {
      closed.push('issue-editor');
      state.rosterImport.issueEditor = null;
    },
    closeConstraintChat() {
      closed.push('chat');
    },
    closeProblemDetails() {
      closed.push('problem');
    },
    closeRangePopover() {
      closed.push('range');
      state.rangePopover = null;
    },
    closeSmartWorkbench() {
      closed.push('smart');
      state.smartWorkbench.open = false;
    },
    render() {
      closed.push('render');
    },
  };
  let removedDetails = 0;
  let openDetails = [{ removeAttribute() { removedDetails += 1; } }];
  const state = {
    restoreDialog: { open: true },
    publicationHistoryDialog: { open: true },
    publishDialog: { open: true },
    periodTimeDialog: { open: true },
    rosterImport: { open: true, issueEditor: { rowId: 'draft_1', field: 'blockPreference' } },
    constraintChat: { open: true },
    problemDetailDialog: { open: true, problem: { id: 'p1' } },
    rangePopover: { id: 'activeWeekdays' },
    smartWorkbench: { open: true },
    selectedSlotId: 'slot-1',
    inspectorOpen: true,
  };
  const container = {
    querySelectorAll() {
      return openDetails;
    },
  };

  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.deepEqual(closed, ['restore']);

  state.restoreDialog.open = false;
  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history']);

  state.publicationHistoryDialog.open = false;
  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish']);

  state.publishDialog.open = false;
  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish', 'period']);

  state.periodTimeDialog.open = false;
  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish', 'period', 'issue-editor']);

  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish', 'period', 'issue-editor', 'roster']);

  state.rosterImport.open = false;
  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish', 'period', 'issue-editor', 'roster', 'chat']);

  state.constraintChat.open = false;
  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish', 'period', 'issue-editor', 'roster', 'chat', 'problem']);

  state.problemDetailDialog.open = false;
  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish', 'period', 'issue-editor', 'roster', 'chat', 'problem', 'range']);
  assert.equal(removedDetails, 0);
  assert.equal(state.selectedSlotId, 'slot-1');

  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish', 'period', 'issue-editor', 'roster', 'chat', 'problem', 'range']);
  assert.equal(removedDetails, 1);
  assert.equal(state.selectedSlotId, 'slot-1');

  openDetails = [];
  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish', 'period', 'issue-editor', 'roster', 'chat', 'problem', 'range', 'smart']);
  assert.equal(state.selectedSlotId, 'slot-1');

  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish', 'period', 'issue-editor', 'roster', 'chat', 'problem', 'range', 'smart', 'render']);
  assert.equal(state.selectedSlotId, '');
  assert.equal(state.inspectorOpen, false);

  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.equal(stopped, true);
});

test('timetable tool handles Escape before the app launcher can close the tool', async () => {
  const launcherSource = await readFile(appLauncherPath, 'utf8');
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');

  assert.match(launcherSource, /currentToolInstance[\s\S]*handleEscape[\s\S]*return;/);
  assert.match(controllerSource, /handleEscape\(event\)\s*{[\s\S]*handleTimetableEscape\(event,\s*this\.state\.container,\s*this,\s*this\.state\)/);
});

test('timetable left sidebar range workflow applies only from the range popover done button', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const stateSource = await readFile(new URL('state.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(stateSource, /workflowOpenSections/);
  assert.match(stateSource, /rangeDraft/);
  assert.match(stateSource, /rangePopover/);
  assert.match(stateSource, /bulkRuleDraft/);
  assert.match(controllerSource, /toggleWorkflowSection\(/);
  assert.match(controllerSource, /toggleRangePopover\(/);
  assert.match(controllerSource, /closeRangePopover\(/);
  assert.match(controllerSource, /repositionRangePopover\(/);
  assert.match(controllerSource, /updateRangeDraftFromForm\(/);
  assert.match(controllerSource, /applyRangeDraft\(/);
  assert.match(interactionSource, /data-tt-section-toggle/);
  assert.match(interactionSource, /\[data-range-popover-trigger\]/);
  assert.match(interactionSource, /\[data-range-popover-panel\]/);
  assert.match(interactionSource, /closeRangePopover/);
  assert.doesNotMatch(interactionSource, /#tt-apply-range/);
  assert.doesNotMatch(interactionSource, /#tt-reset-range/);
  assert.match(interactionSource, /\[data-range-apply\]/);
  assert.match(interactionSource, /applyRangeDraft\(/);
  assert.match(interactionSource, /\[data-active-weekday\]/);
  assert.match(interactionSource, /\[data-active-period\]/);
  assert.doesNotMatch(interactionSource, /\[data-active-weekday\][\s\S]{0,160}saveProject\(/);
  assert.doesNotMatch(interactionSource, /\[data-active-period\][\s\S]{0,160}saveProject\(/);
  assert.match(styles, /\.tt-workflow-panel/);
  assert.match(styles, /\.tt-range-summary-grid/);
  assert.match(styles, /\.tt-multi-select/);
  assert.match(styles, /\.tt-multi-select\.is-open,[\s\S]*\.tt-multi-select\[open\]\s*{\s*z-index:\s*120;\s*}/);
  assert.match(styles, /\.tt-multi-select-popover\s*{[\s\S]*z-index:\s*130;/);
  assert.match(styles, /\.tt-floating-popover-layer\s*{[\s\S]*position:\s*fixed;[\s\S]*z-index:\s*70;[\s\S]*pointer-events:\s*none;/);
  assert.match(styles, /\.tt-floating-popover-layer \.tt-multi-select-popover\s*{[\s\S]*position:\s*fixed;[\s\S]*top:\s*var\(--tt-floating-popover-top/);
  assert.match(styles, /\.tt-range-summary-detail\s*{/);
  assert.doesNotMatch(styles, /\.tt-range-summary-extra\s*{/);
  assert.match(styles, /\.tt-period-time-entry-action\s*{/);
  assert.match(styles, /\.tt-period-time-entry-range\s*{/);
  assert.match(styles, /\.tt-period-time-entry-status\s*{/);
  assert.doesNotMatch(styles, /\.tt-range-setup-card\s+\.tt-range-summary-icon\s*{/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-multi-select\.is-open,[\s\S]*\.tt-multi-select\[open\]\s*{\s*z-index:\s*auto;\s*}[\s\S]*\.tt-floating-popover-layer \.tt-multi-select-popover\s*{[\s\S]*position:\s*fixed;/);
});

test('timetable period time setup uses a compact entry and modal editor', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      activePeriods: [1, 2, 3],
      periodTimes: [
        { period: 1, start: '08:00', end: '08:40' },
        { period: 2, start: '08:50', end: '09:30' },
      ],
    }),
  });

  const closed = renderWorkbench(state);
  const sidebar = closed.slice(closed.indexOf('<aside class="tt-sidebar"'), closed.indexOf('<section class="tt-schedule-panel"'));

  assert.match(sidebar, /id="tt-open-period-time-dialog"/);
  assert.match(sidebar, /节次时间/);
  assert.match(sidebar, /tt-period-time-entry-range">08:00-09:30</);
  assert.match(sidebar, /tt-period-time-entry-status">2节 · 已配置</);
  assert.match(sidebar, /tt-period-time-entry-action">配置时间</);
  assert.doesNotMatch(sidebar, /class="tt-period-time-table"/);
  assert.doesNotMatch(sidebar, /data-period-time-draft-start/);

  const open = renderWorkbench({
    ...state,
    periodTimeDialog: {
      open: true,
      draftTimes: state.project.periodTimes,
      segmentConfig: {
        globalDefaults: { classMinutes: 45, breakMinutes: 10 },
        segments: [
          { id: 'seg-1', label: '上午时段', startTime: '08:00', periodCount: 3, classMinutes: null, breakMinutes: null },
        ],
      },
    },
  });

  assert.match(open, /id="tt-period-time-dialog"/);
  assert.match(open, /id="tt-segment-global-class-minutes"/);
  assert.match(open, /id="tt-segment-global-break-minutes"/);
  assert.match(open, /id="tt-add-segment"/);
  assert.match(open, /data-segment-template="standard"/);
  assert.match(open, /data-segment-template="withMorningEvening"/);
  assert.match(open, /data-segment-template="juniorHigh"/);
  assert.match(open, /data-segment-id="seg-1"/);
  assert.match(open, /data-segment-field="seg-1-label"/);
  assert.match(open, /data-segment-field="seg-1-startTime"/);
  assert.match(open, /data-segment-field="seg-1-periodCount"/);
  assert.match(open, /data-segment-field="seg-1-kind"/);
  assert.match(open, /data-segment-field="seg-1-dutyEnabled"/);
  assert.match(open, />正式节次</);
  assert.match(open, />附加时段</);
  assert.match(open, /tt-segment-group--teaching[\s\S]*tt-segment-group-rule[\s\S]*正式节次/);
  assert.doesNotMatch(open, /data-lucide="list-ordered"|data-lucide="clock-3"/);
  assert.match(open, /值班教师/);
  assert.doesNotMatch(open, />正式课</);
  assert.doesNotMatch(open, />非正式时段</);
  assert.doesNotMatch(open, />自习值班</);
  assert.doesNotMatch(open, />仅展示</);
  assert.match(open, /data-period-time-row="1"/);
  assert.match(open, /data-period-time-draft-start="1"/);
  assert.match(open, /data-period-time-draft-end="1"/);
  assert.match(open, /data-period-time-gap-after="1"/);
  assert.match(open, /data-period-time-gap-after="2"/);
  assert.doesNotMatch(open, /data-period-time-gap-after="3"/);
  assert.match(open, /data-label="开始时间"/);
  assert.match(open, /data-label="本节后间隔"/);
  assert.match(open, /id="tt-clear-period-times"/);
  assert.match(open, /id="tt-cancel-period-times-secondary"[^>]*>[\s\S]*data-lucide="x"[\s\S]*<span>取消<\/span>/);
  assert.match(open, /id="tt-save-period-times"/);
  assert.match(open, /id="tt-cancel-period-times"/);
  assert.match(styles, /\.tt-period-time-entry\s*{/);
  assert.match(styles, /\.tt-period-time-settings\s*{/);
  assert.match(styles, /\.tt-period-time-dialog\s*{/);
  assert.match(styles, /\.tt-period-time-table\s*{/);
  assert.match(styles, /\.tt-period-time-label-note\s*{/);
  assert.match(styles, /\.tt-period-time-block-row--separated > td\s*{[^}]*border-top:\s*2px solid var\(--tt-border-strong\);/);
  assert.match(styles, /\.tt-segment-card\s*{/);
  assert.match(styles, /\.tt-segment-list\s*{/);
  assert.match(styles, /\.tt-segment-group-head\s*{/);
  assert.match(styles, /\.tt-segment-group-rule\s*{/);
  assert.doesNotMatch(styles, /\.tt-segment-group-icon\s*{/);
  assert.match(styles, /\.tt-global-defaults\s*{/);
  assert.match(styles, /\.tt-roster-review-field\s*{[\s\S]*box-sizing:\s*border-box;/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-period-time-dialog/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-period-time-table,[\s\S]*\.tt-period-time-table thead,[\s\S]*\.tt-period-time-table tbody,[\s\S]*\.tt-period-time-table tr,[\s\S]*\.tt-period-time-table th,[\s\S]*\.tt-period-time-table td\s*{[\s\S]*display:\s*block;/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-period-time-table td\s*{[\s\S]*grid-template-columns:\s*88px minmax\(0,\s*1fr\);/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-period-time-table \.tt-period-time-block-row--separated::before\s*{[^}]*height:\s*2px;[^}]*background:\s*var\(--tt-border-strong\);/);
  assert.match(interactionSource, /#tt-open-period-time-dialog/);
  assert.match(interactionSource, /\[data-segment-field\]/);
  assert.match(interactionSource, /\[data-global-default-field\]/);
  assert.match(interactionSource, /\[data-segment-template\]/);
  assert.match(interactionSource, /\[data-add-segment\]/);
  assert.match(interactionSource, /\[data-remove-segment\]/);
  assert.match(interactionSource, /\[data-period-time-gap-after\]/);
  assert.match(interactionSource, /#tt-save-period-times/);
});

test('timetable period time dialog shows early and evening study as editable non-formal rows', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      activeWeekdays: [1, 2],
      periodTimeSegments: {
        globalDefaults: { classMinutes: 40, breakMinutes: 10 },
        segments: [
          { id: 'early-study', label: '早读', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
          { id: 'morning', label: '上午', startTime: '08:00', periodCount: 4, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
          { id: 'afternoon', label: '下午', startTime: '14:00', periodCount: 3, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
          { id: 'evening-study', label: '晚自习', startTime: '19:00', periodCount: 2, classMinutes: 45, breakMinutes: 10, kind: 'duty' },
          { id: 'campus-display', label: '离校提醒', startTime: '20:50', periodCount: 1, classMinutes: 20, breakMinutes: 0, kind: 'display' },
        ],
      },
      periodTimes: [
        { period: 1, start: '08:00', end: '08:40' },
        { period: 2, start: '08:50', end: '09:30' },
        { period: 3, start: '09:40', end: '10:20' },
        { period: 4, start: '10:30', end: '11:10' },
        { period: 5, start: '14:00', end: '14:40' },
        { period: 6, start: '14:50', end: '15:30' },
        { period: 7, start: '15:40', end: '16:20' },
      ],
    }),
    periodTimeDialog: {
      open: true,
      draftTimes: [
        { period: 1, start: '08:00', end: '08:40' },
        { period: 2, start: '08:50', end: '09:30' },
        { period: 3, start: '09:40', end: '10:20' },
        { period: 4, start: '10:30', end: '11:10' },
        { period: 5, start: '14:00', end: '14:40' },
        { period: 6, start: '14:50', end: '15:30' },
        { period: 7, start: '15:40', end: '16:20' },
      ],
      segmentConfig: {
        globalDefaults: { classMinutes: 40, breakMinutes: 10 },
        segments: [
          { id: 'early-study', label: '早读', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
          { id: 'morning', label: '上午', startTime: '08:00', periodCount: 4, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
          { id: 'afternoon', label: '下午', startTime: '14:00', periodCount: 3, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
          { id: 'evening-study', label: '晚自习', startTime: '19:00', periodCount: 2, classMinutes: 45, breakMinutes: 10, kind: 'duty' },
          { id: 'campus-display', label: '离校提醒', startTime: '20:50', periodCount: 1, classMinutes: 20, breakMinutes: 0, kind: 'display' },
        ],
      },
    },
  });

  const open = renderWorkbench(state);

  assert.match(open, /节次时间轴/);
  assert.doesNotMatch(open, /正式课节次时间轴/);
  assert.match(open, /配置作息时段，系统生成节次时间轴。/);
  assert.match(open, /正式节次可微调；附加时段随上方配置同步。/);
  assert.doesNotMatch(open, /tt-nonformal-time-preview/);
  assert.doesNotMatch(open, /data-nonformal-time-preview-slot/);
  assert.match(open, /tt-segment-group--additional[\s\S]*tt-segment-group-rule[\s\S]*附加时段/);
  assert.match(open, /tt-segment-index">时段1 · 附加时段 · 值班/);
  assert.match(open, /tt-segment-index">时段2 · 正式节次 · 4节/);
  assert.match(open, /tt-segment-index">时段4 · 附加时段 · 值班/);
  assert.match(open, /tt-segment-index">时段5 · 附加时段 · 值班/);
  assert.match(open, /tt-segment-index">时段6 · 附加时段/);
  assert.doesNotMatch(open, /早读等附加时段显示时间/);
  assert.doesNotMatch(open, /上午、下午、晚自习等正式时段/);
  assert.doesNotMatch(open, /将生成/);
  assert.doesNotMatch(open, /不占正式节次/);
  assert.match(open, /data-period-time-block-row="early-study" class="tt-period-time-block-row tt-period-time-block-row--duty\s*"[\s\S]*<td class="tt-period-time-label" data-label="节次"><strong>早读<\/strong><span class="tt-period-time-label-note">值班教师<\/span><\/td>[\s\S]*data-period-time-block-start="early-study"[\s\S]*value="07:20"[\s\S]*data-period-time-block-end="early-study"[\s\S]*value="07:50"/);
  assert.match(open, /data-period-time-block-row="evening-study__p1" class="tt-period-time-block-row tt-period-time-block-row--duty tt-period-time-block-row--separated"[\s\S]*<td class="tt-period-time-label" data-label="节次"><strong>晚自习1<\/strong><span class="tt-period-time-label-note">值班教师<\/span><\/td>[\s\S]*data-period-time-block-start="evening-study__p1"[\s\S]*value="19:00"[\s\S]*data-period-time-block-end="evening-study__p1"[\s\S]*value="19:45"/);
  assert.match(open, /data-period-time-block-row="evening-study__p2" class="tt-period-time-block-row tt-period-time-block-row--duty\s*"[\s\S]*<td class="tt-period-time-label" data-label="节次"><strong>晚自习2<\/strong><span class="tt-period-time-label-note">值班教师<\/span><\/td>[\s\S]*data-period-time-block-start="evening-study__p2"[\s\S]*value="19:55"[\s\S]*data-period-time-block-end="evening-study__p2"[\s\S]*value="20:40"/);
  assert.equal((open.match(/tt-period-time-block-row--separated/g) || []).length, 1);
  assert.doesNotMatch(open, /data-period-time-block-row="early-study"[\s\S]{0,200}第1节/);
  assert.doesNotMatch(open, /data-period-time-block-row="evening-study__p1"[\s\S]{0,200}第8节/);
  assert.doesNotMatch(open, /data-period-time-block-row="evening-study__p2"[\s\S]{0,200}第9节/);
  assert.match(open, /第1节[\s\S]*08:00[\s\S]*08:40/);
  assert.doesNotMatch(open, /tt-period-time-segment-header"><td colspan="4"><strong>晚自习/);
  assert.doesNotMatch(open, /data-period-time-row="8"/);
  assert.doesNotMatch(open, /data-period-time-draft-start="8"/);
  assert.doesNotMatch(open, />非正式时段<|>仅展示<|>正式课</);
  assert.match(open, /data-period-time-block-row="campus-display"[\s\S]*离校提醒[\s\S]*20:50[\s\S]*21:10/);
  assert.doesNotMatch(open, /tt-nonformal-time-item[\s\S]{0,200}早读/);
  assert.doesNotMatch(open, /tt-nonformal-time-item[\s\S]{0,200}晚自习/);
});

test('timetable period time entry summarizes non-formal study blocks and excludes them from formal periods', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      activeWeekdays: [1, 2],
      periodTimeSegments: {
        globalDefaults: { classMinutes: 40, breakMinutes: 10 },
        segments: [
          { id: 'early-study', label: '早自习', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
          { id: 'morning', label: '上午', startTime: '08:00', periodCount: 3, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
          { id: 'evening-study', label: '晚自习', startTime: '19:00', periodCount: 1, classMinutes: 45, breakMinutes: 10, kind: 'duty' },
        ],
      },
      periodTimes: [
        { period: 1, start: '08:00', end: '08:40' },
        { period: 2, start: '08:50', end: '09:30' },
        { period: 3, start: '09:40', end: '10:20' },
      ],
    }),
  });

  const closed = renderWorkbench(state);
  const sidebar = closed.slice(closed.indexOf('<aside class="tt-sidebar"'), closed.indexOf('<section class="tt-schedule-panel"'));

  assert.match(sidebar, /data-range-label="可用节次"[\s\S]*<strong>3节 · 附加2段<\/strong>[\s\S]*<small class="tt-range-summary-detail" title="上午3 · 早自习1 · 晚自习1">上午3 · 早自习1 · 晚自习1<\/small>/);
  assert.equal((sidebar.match(/tt-range-summary-detail/g) || []).length, 1);
  assert.doesNotMatch(sidebar, /tt-range-summary-extra/);
  assert.match(sidebar, /tt-period-time-entry-range">07:20-19:45</);
  assert.match(sidebar, /tt-period-time-entry-status">3节 · 附加2段 · 已配置</);
  assert.doesNotMatch(sidebar, /附加：早自习1|附加：晚自习1/);
});

test('timetable range summary names formal time segments from configured blocks', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      activeWeekdays: [1, 2],
      periodTimeSegments: {
        globalDefaults: { classMinutes: 40, breakMinutes: 10 },
        segments: [
          { id: 'early-study', label: '早读', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
          { id: 'morning', label: '上午', startTime: '08:00', periodCount: 2, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
          { id: 'afternoon', label: '下午', startTime: '14:00', periodCount: 1, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
          { id: 'evening-study', label: '晚自习', startTime: '19:00', periodCount: 2, classMinutes: 45, breakMinutes: 10, kind: 'teaching' },
          { id: 'campus-display', label: '离校提醒', startTime: '20:50', periodCount: 1, classMinutes: 20, breakMinutes: 0, kind: 'display' },
        ],
      },
    }),
  });

  const html = renderWorkbench(state);
  const rangeCard = html.match(/data-range-label="可用节次"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '';
  const sidebar = html.slice(html.indexOf('<aside class="tt-sidebar"'), html.indexOf('<section class="tt-schedule-panel"'));

  assert.match(rangeCard, /<strong>5节 · 附加2段<\/strong>/);
  assert.match(rangeCard, /<small class="tt-range-summary-detail" title="上午2 · 下午1 · 晚自习2 · 早读1 · 离校提醒1">上午2 · 下午1 · 晚自习2 · 早读1 · 离校提醒1<\/small>/);
  assert.equal((rangeCard.match(/tt-range-summary-detail/g) || []).length, 1);
  assert.doesNotMatch(rangeCard, /tt-range-summary-extra/);
  assert.match(sidebar, /tt-period-time-entry-range">07:20-21:10</);
  assert.match(sidebar, /tt-period-time-entry-status">5节 · 附加2段 · 已配置</);
  assert.doesNotMatch(sidebar, /由时段配置自动生成/);
  assert.doesNotMatch(sidebar, /tt-range-summary-icon|lock-keyhole/);
});

test('timetable period time presets treat early and evening study as non-formal by default', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.setMessage = () => {};
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3] }));
  controller.state.periodTimeDialog = { open: true, draftTimes: [], segmentConfig: controller.getDefaultSegmentConfig([1, 2, 3]) };

  controller.applySegmentTemplate('withMorningEvening');
  assert.deepEqual(controller.state.periodTimeDialog.segmentConfig.segments.map(segment => segment.kind), [
    'duty',
    'teaching',
    'teaching',
    'duty',
    'duty',
  ]);
  assert.deepEqual(controller.state.periodTimeDialog.segmentConfig.segments.map(segment => segment.label), [
    '早读',
    '上午时段',
    '下午时段',
    '晚自习1',
    '晚自习2',
  ]);
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes.map(item => `${item.period}:${item.segmentLabel}`), [
    '1:上午时段',
    '2:上午时段',
    '3:上午时段',
    '4:上午时段',
    '5:下午时段',
    '6:下午时段',
    '7:下午时段',
  ]);

  controller.applySegmentTemplate('seniorHigh');
  assert.equal(PRESET_TEMPLATES.juniorHigh.description, '标准7节');
  assert.equal(PRESET_TEMPLATES.seniorHigh.segments.find(segment => segment.label === '上午时段')?.periodCount, 4);
  assert.equal(PRESET_TEMPLATES.seniorHigh.segments.find(segment => segment.label === '下午时段')?.periodCount, 4);
  assert.equal(controller.state.periodTimeDialog.segmentConfig.segments[0].kind, 'duty');
  assert.equal(controller.state.periodTimeDialog.segmentConfig.segments[3].kind, 'duty');
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes.map(item => `${item.period}:${item.segmentLabel}`), [
    '1:上午时段',
    '2:上午时段',
    '3:上午时段',
    '4:上午时段',
    '5:下午时段',
    '6:下午时段',
    '7:下午时段',
    '8:下午时段',
  ]);
});

test('timetable schedule grid renders non-formal study blocks without ordinary pending cells', () => {
  const state = sampleWorkbenchState();
  state.project = createDefaultTimetableProject({
    activeWeekdays: [1, 2],
    teachers: [
      { id: 't_duty', name: 'Duty Teacher', subjects: [], unavailableSlots: [] },
      { id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] },
    ],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    periodTimeSegments: {
      globalDefaults: { classMinutes: 40, breakMinutes: 10 },
      segments: [
        { id: 'early-study', label: '早自习', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
        { id: 'morning', label: '上午', startTime: '08:00', periodCount: 2, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
        { id: 'evening-study', label: '晚自习', startTime: '19:00', periodCount: 2, classMinutes: 45, breakMinutes: 10, kind: 'duty' },
      ],
    },
    periodTimes: [
      { period: 1, start: '08:00', end: '08:40' },
      { period: 2, start: '08:50', end: '09:30' },
    ],
    dutyAssignments: [
      { id: 'duty-1', day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: 't_duty' },
      { id: 'duty-evening', day: 1, classId: 'c1', timeBlockId: 'evening-study', teacherId: 't_duty' },
    ],
    schedule: {
      source: 'fast_constructed',
      slots: [{ id: 'slot_1', classId: 'c1', subjectId: 'math', teacherId: 't_math', day: 1, period: 1 }],
    },
  });

  const panel = renderSchedulePanel(state);

  assert.match(panel, /data-time-block-id="early-study"[\s\S]*早自习[\s\S]*07:20-07:50[\s\S]*值班/);
  assert.match(panel, /data-action="edit-duty-assignment"[\s\S]*Duty Teacher/);
  assert.match(panel, /tt-duty-cell/);
  assert.match(panel, /data-period-segment-id="morning"[\s\S]*第1节[\s\S]*08:00-08:40/);
  assert.match(panel, /data-period-segment-id="morning"[\s\S]*第2节[\s\S]*08:50-09:30/);
  assert.match(panel, /data-time-block-id="evening-study__p1"[\s\S]*晚自习1[\s\S]*19:00-19:45[\s\S]*值班/);
  assert.match(panel, /data-time-block-id="evening-study__p2"[\s\S]*晚自习2[\s\S]*19:55-20:40[\s\S]*值班/);
  assert.match(panel, /data-time-block-id="evening-study__p1"[\s\S]*data-action="edit-duty-assignment"[\s\S]*Duty Teacher/);
  assert.match(panel, /data-time-block-id="evening-study__p2"[\s\S]*data-action="edit-duty-assignment"[\s\S]*Duty Teacher/);
  assert.doesNotMatch(panel, /data-period-segment-id="evening-study"[\s\S]*第3节/);
  assert.doesNotMatch(panel, /data-time-block-id="evening-study__p1"[\s\S]{0,220}待排/);
  assert.doesNotMatch(panel, /data-time-block-id="evening-study__p2"[\s\S]{0,220}待排/);
  assert.doesNotMatch(panel, /第1节[\s\S]{0,120}07:20-07:50/);
});

test('timetable legacy duty blocks create additional duty cells and render the editor dialog', () => {
  const state = sampleWorkbenchState();
  state.project = createDefaultTimetableProject({
    activeWeekdays: [1],
    teachers: [
      { id: 't_duty', name: 'Duty Teacher', subjects: [], unavailableSlots: [] },
      { id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] },
    ],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    periodTimeSegments: {
      globalDefaults: { classMinutes: 40, breakMinutes: 10 },
      segments: [
        { id: 'early-study', label: '早自习', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
        { id: 'morning', label: '上午', startTime: '08:00', periodCount: 1, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
      ],
    },
    dutyAssignments: [{ id: 'duty-1', day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: 't_duty' }],
  });

  const panel = renderSchedulePanel(state);
  assert.match(panel, /data-action="edit-duty-assignment"/);
  assert.match(panel, /tt-duty-cell/);
  assert.match(panel, /早自习[\s\S]*07:20-07:50[\s\S]*值班/);
  assert.match(panel, /第1节[\s\S]*08:00-08:40/);

  const html = renderWorkbench({
    ...state,
    dutyDialog: {
      open: true,
      day: 1,
      classId: 'c1',
      timeBlockId: 'early-study',
      teacherId: 't_duty',
    },
  });

  assert.match(html, /id="tt-duty-assignment-dialog"/);
  assert.match(html, /编辑值班老师/);
  assert.match(html, /早自习/);
  assert.match(html, /Duty Teacher/);
  assert.match(html, /id="tt-save-duty-assignment"/);
  assert.match(html, /id="tt-clear-duty-assignment"/);
});

test('timetable class duty editor locks current class and renders read-only context', () => {
  const project = createDefaultTimetableProject({
    activeWeekdays: [1],
    teachers: [
      { id: 't_duty', name: 'Duty Teacher', subjects: [], unavailableSlots: [] },
      { id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] },
    ],
    classes: [
      { id: 'c1', grade: '七年级', name: '1班' },
      { id: 'c2', grade: '七年级', name: '2班' },
    ],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [
      { id: 'lp_math_c1', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
      { id: 'lp_math_c2', classId: 'c2', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
    ],
    periodTimeSegments: {
      globalDefaults: { classMinutes: 40, breakMinutes: 10 },
      segments: [
        { id: 'early-study', label: '早自习', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
        { id: 'morning', label: '上午', startTime: '08:00', periodCount: 1, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
      ],
    },
  });
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.viewMode = 'class';
  controller.state.selectedOwnerId = 'c1';
  controller.applyProject(project);

  controller.openDutyAssignmentDialog(1, 'early-study');

  assert.equal(controller.state.dutyDialog.classId, 'c1');
  assert.equal(controller.state.dutyDialog.classLocked, true);

  const html = renderWorkbench(sampleWorkbenchState({
    project,
    viewMode: 'class',
    selectedOwnerId: 'c1',
    dutyDialog: controller.state.dutyDialog,
  }));
  const dialog = dutyDialogMarkup(html);

  assert.match(dialog, /data-duty-assignment-class-readonly/);
  assert.match(dialog, /七年级1班/);
  assert.doesNotMatch(dialog, /id="tt-duty-assignment-class"/);
  assert.doesNotMatch(dialog, /<option value="c1"/);
  assert.doesNotMatch(dialog, /<option value="c2"/);
  assert.match(dialog, /id="tt-duty-assignment-teacher" type="hidden"/);
  assert.match(dialog, /data-duty-teacher-search/);
  assert.match(dialog, /data-duty-teacher-option/);
  assert.doesNotMatch(dialog, /<select id="tt-duty-assignment-teacher"/);
});

test('timetable duty editor keeps class selector outside locked class context', () => {
  const project = createDefaultTimetableProject({
    activeWeekdays: [1],
    teachers: [
      { id: 't_duty', name: 'Duty Teacher', subjects: [], unavailableSlots: [] },
      { id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] },
    ],
    classes: [
      { id: 'c1', grade: '七年级', name: '1班' },
      { id: 'c2', grade: '七年级', name: '2班' },
    ],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    periodTimeSegments: {
      globalDefaults: { classMinutes: 40, breakMinutes: 10 },
      segments: [
        { id: 'early-study', label: '早自习', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
      ],
    },
  });
  const html = renderWorkbench(sampleWorkbenchState({
    project,
    viewMode: 'teacher',
    selectedOwnerId: 't_duty',
    dutyDialog: {
      open: true,
      day: 1,
      classId: 'c1',
      classLocked: false,
      timeBlockId: 'early-study',
      teacherId: '',
    },
  }));
  const dialog = dutyDialogMarkup(html);

  assert.match(dialog, /id="tt-duty-assignment-class"/);
  assert.match(dialog, /<option value="c1" selected>七年级1班<\/option>/);
  assert.match(dialog, /<option value="c2" >七年级2班<\/option>/);
  assert.doesNotMatch(dialog, /data-duty-assignment-class-readonly/);
});

test('timetable duty teacher search model supports pinyin recommendations and conflict states', () => {
  const project = createDefaultTimetableProject({
    activeWeekdays: [1],
    teachers: [
      { id: 't_math', name: '数学老师', subjects: ['math'], unavailableSlots: [] },
      { id: 't_zhang', name: '张三', subjects: ['duty'], unavailableSlots: [] },
      { id: 't_busy', name: '忙碌老师', subjects: ['duty'], unavailableSlots: [] },
      { id: 't_other_duty', name: '跨班值班老师', subjects: ['duty'], unavailableSlots: [] },
      { id: 't_unavailable', name: '不可排老师', subjects: ['duty'], unavailableSlots: ['1-1'] },
    ],
    classes: [
      { id: 'c1', grade: '七年级', name: '1班' },
      { id: 'c2', grade: '七年级', name: '2班' },
    ],
    subjects: [
      { id: 'math', name: '数学', priority: 90, color: '#2563eb' },
      { id: 'duty', name: '值班', priority: 10, color: '#0891b2' },
    ],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    periodTimes: [{ period: 1, start: '07:30', end: '08:10' }],
    periodTimeSegments: {
      globalDefaults: { classMinutes: 40, breakMinutes: 10 },
      segments: [
        { id: 'early-study', label: '早自习', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
        { id: 'morning', label: '上午', startTime: '08:00', periodCount: 1, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
      ],
    },
    schedule: {
      source: 'fast_constructed',
      slots: [{ id: 'slot-busy', day: 1, period: 1, classId: 'c2', subjectId: 'duty', teacherId: 't_busy' }],
    },
    dutyAssignments: [
      { id: 'duty-c2', day: 1, classId: 'c2', timeBlockId: 'early-study', teacherId: 't_other_duty', source: 'manual', status: 'active' },
    ],
  });
  const context = { day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: '' };

  assert.equal(dutyTeacherSearchQuery('zhang san'), 'zhangsan');
  assert.deepEqual(buildDutyTeacherSearchModel(project, { ...context, query: 'zhangsan' }).visibleOptions.map(item => item.id), ['t_zhang']);
  assert.deepEqual(buildDutyTeacherSearchModel(project, { ...context, query: 'zhang san' }).visibleOptions.map(item => item.id), ['t_zhang']);
  assert.deepEqual(buildDutyTeacherSearchModel(project, { ...context, query: 'zs' }).visibleOptions.map(item => item.id), ['t_zhang']);
  assert.deepEqual(buildDutyTeacherSearchModel(project, { ...context, query: 't_zhang' }).visibleOptions.map(item => item.id), ['t_zhang']);
  assert.equal(buildDutyTeacherSearchModel(project, { ...context, query: '数学' }).visibleOptions[0].id, 't_math');

  const model = buildDutyTeacherSearchModel(project, context);
  assert.equal(model.visibleOptions[0].id, 't_math');
  assert.equal(model.visibleOptions[0].recommended, true);

  const optionsById = new Map(model.options.map(item => [item.id, item]));
  assert.equal(optionsById.get('t_math').meta, '数学');
  assert.doesNotMatch(optionsById.get('t_math').meta, /t_|math/);
  assert.equal(optionsById.get('t_busy').disabled, true);
  assert.equal(optionsById.get('t_busy').conflictReason, '该时段已有正式课');
  assert.equal(optionsById.get('t_other_duty').disabled, true);
  assert.equal(optionsById.get('t_other_duty').conflictReason, '该时段已在其他班值班');
  assert.equal(optionsById.get('t_unavailable').disabled, true);
  assert.equal(optionsById.get('t_unavailable').conflictReason, '教师不可排');

  const selectedConflict = buildDutyTeacherSearchModel(project, { ...context, teacherId: 't_busy' });
  assert.equal(selectedConflict.options.find(item => item.id === 't_busy').selected, true);
  assert.equal(selectedConflict.options.find(item => item.id === 't_busy').disabled, false);
});

test('timetable duty editor renders a searchable teacher picker for large teacher lists', () => {
  const teachers = [
    { id: 't_zhang', name: '张三', subjects: ['math'], unavailableSlots: [] },
    ...Array.from({ length: 80 }, (_, index) => ({
      id: `t_extra_${index + 1}`,
      name: `值班老师${index + 1}`,
      subjects: ['duty'],
      unavailableSlots: [],
    })),
  ];
  const project = createDefaultTimetableProject({
    activeWeekdays: [1],
    teachers,
    classes: [{ id: 'c1', grade: '七年级', name: '1班' }],
    subjects: [
      { id: 'math', name: '数学', priority: 90, color: '#2563eb' },
      { id: 'duty', name: '值班', priority: 10, color: '#0891b2' },
    ],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_zhang', weeklyHours: 1 }],
    periodTimeSegments: {
      globalDefaults: { classMinutes: 40, breakMinutes: 10 },
      segments: [
        { id: 'early-study', label: '早自习', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
      ],
    },
  });
  const html = renderWorkbench(sampleWorkbenchState({
    project,
    dutyDialog: {
      open: true,
      day: 1,
      classId: 'c1',
      classLocked: true,
      timeBlockId: 'early-study',
      teacherId: '',
    },
  }));
  const dialog = dutyDialogMarkup(html);

  assert.match(dialog, /data-duty-teacher-search/);
  assert.match(dialog, /tt-duty-teacher-list/);
  assert.match(dialog, /清除值班/);
  assert.doesNotMatch(dialog, /tt-duty-teacher-option--empty/);
  assert.doesNotMatch(dialog, /data-duty-teacher-empty=/);
  assert.doesNotMatch(dialog, /<strong>不安排值班老师<\/strong>/);
  assert.match(dialog, /placeholder="搜索老师姓名、拼音或学科"/);
  assert.doesNotMatch(dialog, /placeholder="[^"]*ID/);
  assert.match(dialog, /张三/);
  assert.match(dialog, /<small>数学<\/small>/);
  assert.doesNotMatch(dialog, /<small>[^<]*(?:t_|s_)/);
  assert.match(dialog, /data-duty-teacher-search-text="[^"]*zhangsan/);
  assert.match(dialog, /id="tt-duty-assignment-teacher" type="hidden" value=""/);
  assert.doesNotMatch(dialog, /<select id="tt-duty-assignment-teacher"/);
  assert.equal((dialog.match(/data-duty-teacher-option=/g) || []).length, 81);
});

test('timetable duty teacher picker wires click and keyboard interactions', async () => {
  const interactionSource = await readFile(new URL('../public/js/tools/timetable/grid-interactions.js', import.meta.url), 'utf8');
  const controllerSource = await readFile(new URL('../public/js/tools/timetable/controller.js', import.meta.url), 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(interactionSource, /select-duty-teacher/);
  assert.match(interactionSource, /data-duty-teacher-search[\s\S]*ArrowDown/);
  assert.match(interactionSource, /data-duty-teacher-search[\s\S]*ArrowUp/);
  assert.match(interactionSource, /data-duty-teacher-search[\s\S]*Enter/);
  assert.match(interactionSource, /data-duty-teacher-search[\s\S]*Escape/);
  assert.match(controllerSource, /filterDutyTeacherOptions/);
  assert.match(controllerSource, /selectDutyTeacherOption/);
  assert.match(styles, /\.tt-duty-teacher-search-row \.lucide/);
  assert.match(styles, /\.tt-duty-teacher-search:focus,\s*\.tt-duty-teacher-search:focus-visible\s*{[^}]*outline:\s*none !important;[^}]*box-shadow:\s*none !important;/s);
});

test('timetable duty teacher picker navigates multiple filtered candidates', () => {
  const controller = new TimetablePlannerController();
  controller.state.dutyDialog = { open: true, day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: '' };

  const makeOption = (id, label, searchText, { disabled = false } = {}) => {
    const option = {
      id: `option-${id}`,
      hidden: false,
      disabled,
      dataset: {
        dutyTeacherOption: id,
        dutyTeacherLabel: label,
        dutyTeacherSearchText: searchText,
      },
      classes: {},
      attrs: {},
      classList: null,
      setAttribute(name, value) {
        this.attrs[name] = String(value);
        if (name === 'data-duty-teacher-active') this.dataset.dutyTeacherActive = String(value);
      },
      removeAttribute(name) {
        delete this.attrs[name];
        if (name === 'data-duty-teacher-active') delete this.dataset.dutyTeacherActive;
      },
      scrollIntoView() {
        this.scrolled = true;
      },
    };
    option.classList = {
      toggle(name, active) {
        option.classes[name] = Boolean(active);
      },
    };
    return option;
  };

  const options = [
    makeOption('t_zhang_san', '张三', '张三 zhang san zhangsan zs t_zhang_san'),
    makeOption('t_busy', '张三忙', '张三忙 zhang san mang zhangsanmang zhangsan zsm t_busy', { disabled: true }),
    makeOption('t_zhang_san_feng', '张三丰', '张三丰 zhang san feng zhangsanfeng zsf t_zhang_san_feng'),
    makeOption('t_li', '李老师', '李老师 li lao shi lilaoshi lls t_li'),
  ];
  const hiddenInput = {
    value: '',
    setAttribute(name, value) {
      if (name === 'value') this.value = String(value);
    },
  };
  const searchInput = {
    value: 'zhangsan',
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
  };
  const currentLabel = { textContent: '' };
  const emptyMessage = {
    hidden: false,
    toggleAttribute(name, force) {
      if (name === 'hidden') this.hidden = Boolean(force);
    },
  };
  const picker = {
    closed: false,
    classList: {
      add(name) {
        if (name === 'is-closed') picker.closed = true;
      },
      remove(name) {
        if (name === 'is-closed') picker.closed = false;
      },
    },
    querySelector(selector) {
      if (selector === '[data-duty-teacher-search]') return searchInput;
      if (selector === '[data-duty-teacher-empty-message]') return emptyMessage;
      if (selector === '#tt-duty-assignment-teacher') return hiddenInput;
      if (selector === '[data-duty-teacher-current] strong') return currentLabel;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-duty-teacher-option]') return options;
      return [];
    },
  };
  controller.state.container = {
    querySelector(selector) {
      if (selector === '[data-duty-teacher-picker]') return picker;
      return null;
    },
  };

  controller.filterDutyTeacherOptions('zhangsan');
  assert.equal(options[0].hidden, false);
  assert.equal(options[1].hidden, false);
  assert.equal(options[2].hidden, false);
  assert.equal(options[3].hidden, true);
  assert.equal(options[0].dataset.dutyTeacherActive, 'true');

  controller.moveDutyTeacherActive(1);
  assert.equal(options[2].dataset.dutyTeacherActive, 'true');
  assert.equal(options[2].scrolled, true);

  assert.equal(controller.confirmDutyTeacherActive(), true);
  assert.equal(hiddenInput.value, 't_zhang_san_feng');
  assert.equal(currentLabel.textContent, '张三丰');
  assert.equal(controller.state.dutyDialog.teacherId, 't_zhang_san_feng');
});

test('timetable duty editor saves and clears duty assignments without touching lesson plans', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const project = createDefaultTimetableProject({
    activeWeekdays: [1],
    teachers: [
      { id: 't_duty', name: 'Duty Teacher', subjects: [], unavailableSlots: [] },
      { id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] },
    ],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    periodTimeSegments: {
      globalDefaults: { classMinutes: 40, breakMinutes: 10 },
      segments: [
        { id: 'early-study', label: '早自习', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
        { id: 'morning', label: '上午', startTime: '08:00', periodCount: 1, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
      ],
    },
    dutyAssignments: [{ id: 'duty-1', day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: 't_duty', source: 'manual' }],
  });

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          data: {
            project: createDefaultTimetableProject({
              ...project,
              ...body,
            }),
          },
        };
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.setMessage = () => {};
    controller.applyProject(project);
    controller.state.dutyDialog = { open: true, day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: 't_math' };

    await controller.saveDutyAssignmentDialog();
    assert.equal(calls[0].body.lessonPlans, undefined);
    assert.deepEqual(calls[0].body.dutyAssignments, [{
      id: 'duty-1',
      day: 1,
      classId: 'c1',
      timeBlockId: 'early-study',
      teacherId: 't_math',
      source: 'manual',
      status: 'active',
    }]);

    controller.state.dutyDialog = { open: true, day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: 't_math' };
    await controller.clearDutyAssignmentDialog();
    assert.deepEqual(calls[1].body.dutyAssignments, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable locked duty editor saves and clears only the current class without a class selector', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const c2Duty = {
    id: 'duty-c2',
    day: 1,
    classId: 'c2',
    timeBlockId: 'early-study',
    teacherId: 't_other',
    source: 'manual',
    status: 'active',
  };
  const project = createDefaultTimetableProject({
    activeWeekdays: [1],
    teachers: [
      { id: 't_duty', name: 'Duty Teacher', subjects: [], unavailableSlots: [] },
      { id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] },
      { id: 't_other', name: 'Other Teacher', subjects: [], unavailableSlots: [] },
    ],
    classes: [
      { id: 'c1', grade: '七年级', name: '1班' },
      { id: 'c2', grade: '七年级', name: '2班' },
    ],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [
      { id: 'lp_math_c1', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
      { id: 'lp_math_c2', classId: 'c2', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
    ],
    periodTimeSegments: {
      globalDefaults: { classMinutes: 40, breakMinutes: 10 },
      segments: [
        { id: 'early-study', label: '早自习', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
      ],
    },
    dutyAssignments: [
      { id: 'duty-c1', day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: 't_duty', source: 'manual', status: 'active' },
      c2Duty,
    ],
  });

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          data: {
            project: createDefaultTimetableProject({
              ...project,
              ...body,
            }),
          },
        };
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.setMessage = () => {};
    controller.applyProject(project);
    controller.state.container = {
      querySelector(selector) {
        if (selector === '#tt-duty-assignment-teacher') return { value: 't_math' };
        return null;
      },
    };
    controller.state.dutyDialog = {
      open: true,
      day: 1,
      classId: 'c1',
      classLocked: true,
      timeBlockId: 'early-study',
      teacherId: 't_duty',
    };

    await controller.saveDutyAssignmentDialog();

    assert.deepEqual(calls[0].body.dutyAssignments, [
      c2Duty,
      {
        id: 'duty-c1',
        day: 1,
        classId: 'c1',
        timeBlockId: 'early-study',
        teacherId: 't_math',
        source: 'manual',
        status: 'active',
      },
    ]);

    controller.state.dutyDialog = {
      open: true,
      day: 1,
      classId: 'c1',
      classLocked: true,
      timeBlockId: 'early-study',
      teacherId: 't_math',
    };
    await controller.clearDutyAssignmentDialog();

    assert.deepEqual(calls[1].body.dutyAssignments, [c2Duty]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable period time segment labels drive timeline group headers', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      activePeriods: [1, 2, 3, 4],
      periodTimes: [
        { period: 1, start: '08:00', end: '08:40' },
        { period: 2, start: '08:50', end: '09:30' },
        { period: 3, start: '14:00', end: '14:40' },
        { period: 4, start: '14:50', end: '15:30' },
      ],
    }),
    periodTimeDialog: {
      open: true,
      draftTimes: [
        { period: 1, start: '08:00', end: '08:40' },
        { period: 2, start: '08:50', end: '09:30' },
        { period: 3, start: '14:00', end: '14:40' },
        { period: 4, start: '14:50', end: '15:30' },
      ],
      segmentConfig: {
        globalDefaults: { classMinutes: 40, breakMinutes: 10 },
        segments: [
          { id: 'seg-1', label: '自定义上午', startTime: '08:00', periodCount: 2, classMinutes: null, breakMinutes: null },
          { id: 'seg-2', label: '自定义下午', startTime: '14:00', periodCount: 2, classMinutes: null, breakMinutes: null },
        ],
      },
    },
  });

  const html = renderWorkbench(state);

  assert.match(html, /tt-period-time-segment-header[\s\S]*自定义上午/);
  assert.match(html, /tt-period-time-segment-header[\s\S]*自定义下午/);
});

test('timetable period time segment label edits update timeline headers without rerendering the modal', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('segment label edits should update timeline headers without rerendering the modal');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3, 4] }));
  const previousConfig = {
    globalDefaults: { classMinutes: 40, breakMinutes: 10 },
    segments: [
      { id: 'seg-1', label: '上午时段', startTime: '08:00', periodCount: 2, classMinutes: null, breakMinutes: null },
      { id: 'seg-2', label: '下午时段', startTime: '14:00', periodCount: 2, classMinutes: null, breakMinutes: null },
    ],
  };
  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 270 },
    { period: 3, start: '14:00', end: '14:40', gapAfter: 10 },
    { period: 4, start: '14:50', end: '15:30' },
  ], {}, {
    'seg-1': { label: '自定义上午', startTime: '08:00', periodCount: 2, classMinutes: null, breakMinutes: null },
    'seg-2': { label: '自定义下午', startTime: '14:00', periodCount: 2, classMinutes: null, breakMinutes: null },
  });
  dom.tableBody.insertBefore(dom.createSegmentHeader('上午时段'), dom.rows[0]);
  dom.tableBody.insertBefore(dom.createSegmentHeader('下午时段'), dom.rows[2]);
  controller.state.container = dom;
  controller.state.periodTimeDialog = {
    ...controller.state.periodTimeDialog,
    open: true,
    segmentConfig: previousConfig,
    draftTimes: controller.buildPeriodTimesFromSegments(previousConfig, [1, 2, 3, 4]),
  };

  controller.updateSegmentConfigFromForm();

  const headerTexts = dom.tableBody
    .querySelectorAll('.tt-period-time-segment-header')
    .map(header => header.querySelector('strong')?.textContent);
  assert.deepEqual(headerTexts, ['自定义上午', '自定义下午']);
  assert.equal(controller.state.periodTimeDialog.draftTimes[0].segmentLabel, '自定义上午');
  assert.equal(controller.state.periodTimeDialog.draftTimes[2].segmentLabel, '自定义下午');
});

test('timetable period time display-only segment edits refresh the preview when formal count is unchanged', () => {
  const controller = new TimetablePlannerController();
  let renderCount = 0;
  controller.render = () => {
    renderCount += 1;
  };
  controller.applyProject(createDefaultTimetableProject({
    activePeriods: [1, 2, 3],
    periodTimeSegments: {
      globalDefaults: { classMinutes: 40, breakMinutes: 10 },
      segments: [
        { id: 'early-study', label: '早读', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'display' },
        { id: 'morning', label: '上午', startTime: '08:00', periodCount: 3, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
        { id: 'evening-study', label: '晚自习', startTime: '19:00', periodCount: 2, classMinutes: 45, breakMinutes: 10, kind: 'display' },
      ],
    },
  }));
  renderCount = 0;
  const previousConfig = {
    globalDefaults: { classMinutes: 40, breakMinutes: 10 },
    segments: [
      { id: 'early-study', label: '早读', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'display' },
      { id: 'morning', label: '上午', startTime: '08:00', periodCount: 3, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
      { id: 'evening-study', label: '晚自习', startTime: '19:00', periodCount: 2, classMinutes: 45, breakMinutes: 10, kind: 'display' },
    ],
  };
  controller.state.container = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
    { period: 3, start: '09:40', end: '10:20' },
  ], {
    classMinutes: 40,
    breakMinutes: 10,
    nonformalPreviewHtml: '早读 07:20-07:50 附加时段',
    timelineHtml: '上午 第1节',
  }, {
    'early-study': { label: '早读', startTime: '07:30', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'display' },
    morning: { label: '上午', startTime: '08:00', periodCount: 3, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
    'evening-study': { label: '晚自习', startTime: '19:00', periodCount: 2, classMinutes: 45, breakMinutes: 10, kind: 'display' },
  });
  controller.state.periodTimeDialog = {
    open: true,
    segmentConfig: previousConfig,
    draftTimes: controller.buildPeriodTimesFromSegments(previousConfig, [1, 2, 3]),
  };

  controller.updateSegmentConfigFromForm();

  assert.equal(renderCount, 0);
  assert.equal(controller.state.periodTimeDialog.segmentConfig.segments[0].startTime, '07:30');
  assert.match(controller.state.container.nonformalPreviewSlot.innerHTML, /早读[\s\S]*附加时段[\s\S]*07:30-08:00/);
  assert.match(controller.state.container.nonformalPreviewSlot.innerHTML, /晚自习[\s\S]*附加时段/);
  assert.match(controller.state.container.periodTimeTableBodySlot.innerHTML, /data-period-time-block-row="early-study"[\s\S]*value="07:30"[\s\S]*value="08:00"/);
  assert.match(controller.state.container.periodTimeTableBodySlot.innerHTML, /data-period-time-block-row="evening-study__p1"[\s\S]*value="19:00"[\s\S]*value="19:45"/);
  assert.match(controller.state.container.periodTimeTableBodySlot.innerHTML, /data-period-time-block-row="evening-study__p2"[\s\S]*value="19:55"[\s\S]*value="20:40"/);
  assert.doesNotMatch(controller.state.container.periodTimeTableBodySlot.innerHTML, /data-period-time-block-row="early-study"[\s\S]{0,200}值班/);
});

test('timetable period time block row edits update non-formal segments without formalizing them', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('time block edits should not rerender the whole dialog');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3] }));
  const previousConfig = {
    globalDefaults: { classMinutes: 40, breakMinutes: 10 },
    segments: [
      { id: 'early-study', label: '早读', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
      { id: 'morning', label: '上午', startTime: '08:00', periodCount: 3, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
      { id: 'evening-study', label: '晚自习', startTime: '19:00', periodCount: 2, classMinutes: 45, breakMinutes: 10, kind: 'duty' },
    ],
  };
  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
    { period: 3, start: '09:40', end: '10:20' },
  ], {
    classMinutes: 40,
    breakMinutes: 10,
    timeBlockRows: [
      { id: 'early-study', start: '07:30', end: '08:10' },
      { id: 'evening-study__p1', start: '18:50', end: '19:35' },
      { id: 'evening-study__p2', start: '19:45', end: '20:35' },
    ],
  }, {
    'early-study': { label: '早读', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
    morning: { label: '上午', startTime: '08:00', periodCount: 3, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
    'evening-study__p1': { label: '晚自习1', startTime: '19:00', periodCount: 1, classMinutes: 45, breakMinutes: 10, kind: 'duty' },
    'evening-study__p2': { label: '晚自习2', startTime: '19:55', periodCount: 1, classMinutes: 45, breakMinutes: 10, kind: 'duty' },
  });
  controller.state.container = dom;
  controller.state.periodTimeDialog = {
    open: true,
    segmentConfig: previousConfig,
    draftTimes: controller.buildPeriodTimesFromSegments(previousConfig, [1, 2, 3]),
  };

  controller.updatePeriodTimeBlockFromDom(dom.timeBlockRows[0].startInput);

  const earlySegment = controller.state.periodTimeDialog.segmentConfig.segments[0];
  const eveningFirstSegment = controller.state.periodTimeDialog.segmentConfig.segments.find(segment => segment.id === 'evening-study__p1');
  const eveningSecondSegment = controller.state.periodTimeDialog.segmentConfig.segments.find(segment => segment.id === 'evening-study__p2');
  assert.equal(earlySegment.kind, 'duty');
  assert.equal(earlySegment.startTime, '07:30');
  assert.equal(earlySegment.classMinutes, 40);
  assert.equal(eveningFirstSegment.kind, 'duty');
  assert.equal(eveningFirstSegment.startTime, '18:50');
  assert.equal(eveningFirstSegment.classMinutes, 45);
  assert.equal(eveningSecondSegment.kind, 'duty');
  assert.equal(eveningSecondSegment.startTime, '19:45');
  assert.equal(eveningSecondSegment.classMinutes, 50);
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes.map(item => `${item.period}:${item.start}-${item.end}`), [
    '1:08:00-08:40',
    '2:08:50-09:30',
    '3:09:40-10:20',
  ]);
  assert.equal(dom.querySelector('[data-segment-field="early-study-startTime"]').value, '07:30');
  assert.equal(dom.querySelector('[data-segment-field="early-study-classMinutes"]').value, '40');
  assert.equal(dom.querySelector('[data-segment-field="evening-study__p1-startTime"]').value, '18:50');
  assert.equal(dom.querySelector('[data-segment-field="evening-study__p1-classMinutes"]').value, '45');
  assert.equal(dom.querySelector('[data-segment-field="evening-study__p2-startTime"]').value, '19:45');
  assert.equal(dom.querySelector('[data-segment-field="evening-study__p2-classMinutes"]').value, '50');
});

test('timetable period time segment type maps additional duty switch to internal kinds', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2] }));
  controller.state.container = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30' },
  ], { classMinutes: 40, breakMinutes: 10 }, {
    'early-study': { label: '早读', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'additional', dutyEnabled: false },
    morning: { label: '上午', startTime: '08:00', periodCount: 2, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
    'evening-study': { label: '晚自习', startTime: '19:00', periodCount: 1, classMinutes: 45, breakMinutes: 10, kind: 'additional', dutyEnabled: true },
  });

  const config = controller.readSegmentConfigFromDom();

  assert.deepEqual(config.segments.map(segment => segment.kind), ['display', 'teaching', 'duty']);
});

test('timetable period time duty switch refreshes segment card meta without rerendering', () => {
  const controller = new TimetablePlannerController();
  let renderCount = 0;
  controller.render = () => {
    renderCount += 1;
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2] }));
  renderCount = 0;
  const previousConfig = {
    globalDefaults: { classMinutes: 40, breakMinutes: 10 },
    segments: [
      { id: 'early-study', label: '早读', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
      { id: 'morning', label: '上午', startTime: '08:00', periodCount: 2, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
    ],
  };
  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30' },
  ], {
    classMinutes: 40,
    breakMinutes: 10,
    nonformalPreviewHtml: '早读 07:20-07:50 附加时段 值班',
    timelineHtml: '早读 值班',
  }, {
    'early-study': {
      label: '早读',
      startTime: '07:20',
      periodCount: 1,
      classMinutes: 30,
      breakMinutes: 10,
      kind: 'additional',
      inputKind: 'additional',
      dutyEnabled: false,
      datasetKind: 'duty',
      metaText: '时段1 · 附加时段 · 值班',
    },
    morning: { label: '上午', startTime: '08:00', periodCount: 2, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
  });
  controller.state.container = dom;
  controller.state.periodTimeDialog = {
    open: true,
    segmentConfig: previousConfig,
    draftTimes: controller.buildPeriodTimesFromSegments(previousConfig, [1, 2]),
  };

  controller.updateSegmentConfigFromForm();

  assert.equal(renderCount, 0);
  assert.equal(controller.state.periodTimeDialog.segmentConfig.segments[0].kind, 'display');
  assert.equal(dom.segmentCards[0].dataset.segmentKind, 'display');
  assert.equal(dom.segmentCards[0].segmentIndex.textContent, '时段1 · 附加时段');
  assert.equal(dom.segmentCards[0].dutyStatus.textContent, '关闭');
  assert.doesNotMatch(dom.periodTimeTableBodySlot.innerHTML, /data-period-time-block-row="early-study"[\s\S]{0,200}值班/);
});

test('timetable period time segment kind changes still rerender when teaching count changes', () => {
  const controller = new TimetablePlannerController();
  let renderCount = 0;
  controller.render = () => {
    renderCount += 1;
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3] }));
  renderCount = 0;
  const previousConfig = {
    globalDefaults: { classMinutes: 40, breakMinutes: 10 },
    segments: [
      { id: 'morning', label: '上午', startTime: '08:00', periodCount: 3, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
    ],
  };
  controller.state.container = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
    { period: 3, start: '09:40', end: '10:20' },
  ], { classMinutes: 40, breakMinutes: 10 }, {
    morning: { label: '上午', startTime: '08:00', periodCount: 3, classMinutes: 40, breakMinutes: 10, kind: 'additional', dutyEnabled: false },
  });
  controller.state.periodTimeDialog = {
    open: true,
    segmentConfig: previousConfig,
    draftTimes: controller.buildPeriodTimesFromSegments(previousConfig, [1, 2, 3]),
  };

  controller.updateSegmentConfigFromForm();

  assert.equal(renderCount, 1);
});

test('timetable period time config ignores background schedule segment chips when reading the dialog', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3] }));
  controller.state.container = createPeriodTimeDom([], {
    classMinutes: 40,
    breakMinutes: 10,
    backgroundSegmentIds: ['schedule-morning', 'schedule-evening'],
  }, {
    'early-study': { label: '早读', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
    morning: { label: '上午', startTime: '08:00', periodCount: 3, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
  });

  const config = controller.readSegmentConfigFromDom();

  assert.deepEqual(config.segments.map(segment => segment.id), ['early-study', 'morning']);
  assert.deepEqual(config.segments.map(segment => segment.startTime), ['07:20', '08:00']);
});

test('timetable period time segment edits keep early and evening study outside formal periods by default', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.applyProject(createDefaultTimetableProject({
    activePeriods: [1, 2, 3],
    periodTimeSegments: {
      globalDefaults: { classMinutes: 40, breakMinutes: 10 },
      segments: [
        { id: 'early-study', label: '早自习', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
        { id: 'morning', label: '上午', startTime: '08:00', periodCount: 3, classMinutes: null, breakMinutes: null, kind: 'teaching' },
        { id: 'evening-study', label: '晚自习', startTime: '19:00', periodCount: 1, classMinutes: 45, breakMinutes: 10 },
      ],
    },
  }));
  controller.state.container = createPeriodTimeDom([], { classMinutes: 40, breakMinutes: 10 }, {
    'early-study': { label: '早自习', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
    morning: { label: '上午', startTime: '08:00', periodCount: 3, classMinutes: null, breakMinutes: null, kind: 'teaching' },
    'evening-study': { label: '晚自习', startTime: '19:00', periodCount: 1, classMinutes: 45, breakMinutes: 10, kind: '' },
  });

  const config = controller.readSegmentConfigFromDom();
  const normalized = controller.normalizeSegmentConfig(config, [1, 2, 3]);
  const generatedTimes = controller.buildPeriodTimesFromSegments(normalized, [1, 2, 3]);

  assert.deepEqual(normalized.segments.map(segment => segment.kind), ['duty', 'teaching', 'duty']);
  assert.deepEqual(generatedTimes.map(item => `${item.period}:${item.start}-${item.end}:${item.segmentLabel}`), [
    '1:08:00-08:40:上午',
    '2:08:50-09:30:上午',
    '3:09:40-10:20:上午',
  ]);
});

test('timetable period time save preserves formal periods derived from study-block templates', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const project = createDefaultTimetableProject({ activePeriods: [1, 2, 3] });

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          data: {
            project: createDefaultTimetableProject({
              ...project,
              ...body,
            }),
          },
        };
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.setMessage = () => {};
    controller.applyProject(project);
    controller.state.periodTimeDialog = {
      open: true,
      draftTimes: [],
      segmentConfig: controller.getDefaultSegmentConfig([1, 2, 3]),
    };

    controller.applySegmentTemplate('withMorningEvening');
    controller.state.container = createPeriodTimeDom(
      controller.state.periodTimeDialog.draftTimes,
      { classMinutes: 45, breakMinutes: 10 },
      Object.fromEntries(controller.state.periodTimeDialog.segmentConfig.segments.map(segment => [segment.id, segment])),
    );

    await controller.savePeriodTimes();

    assert.deepEqual(calls[0].body.periodTimes.map(item => item.period), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(calls[0].body.periodTimeSegments.segments.map(segment => segment.kind), [
      'duty',
      'teaching',
      'teaching',
      'duty',
      'duty',
    ]);
    assert.deepEqual(calls[0].body.periodTimeSegments.segments.map(segment => segment.label), [
      '早读',
      '上午时段',
      '下午时段',
      '晚自习1',
      '晚自习2',
    ]);
    assert.equal(calls[0].body.dayPartBoundaries.afternoonStartPeriod, 5);
    assert.equal(calls[0].body.dayPartBoundaries.eveningStartPeriod, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable period time save migrates legacy multi-period duty assignments to split blocks', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const project = {
    ...createDefaultTimetableProject({
      activeWeekdays: [1],
      teachers: [{ id: 't_duty', name: 'Duty Teacher', subjects: [], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      periodTimes: [
        { period: 1, start: '08:00', end: '08:40' },
        { period: 2, start: '08:50', end: '09:30' },
      ],
    }),
    periodTimeSegments: {
      globalDefaults: { classMinutes: 40, breakMinutes: 10 },
      segments: [
        { id: 'morning', label: '上午', startTime: '08:00', periodCount: 2, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
        { id: 'evening-study', label: '晚自习', startTime: '19:00', periodCount: 2, classMinutes: 45, breakMinutes: 10, kind: 'duty' },
      ],
    },
    dutyAssignments: [
      { id: 'duty-evening', day: 1, classId: 'c1', timeBlockId: 'evening-study', teacherId: 't_duty', source: 'manual', status: 'active' },
    ],
  };

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          data: {
            project: createDefaultTimetableProject({
              ...project,
              ...body,
            }),
          },
        };
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.setMessage = () => {};
    controller.applyProject(project);

    controller.openPeriodTimeDialog();
    controller.state.container = createPeriodTimeDom(
      controller.state.periodTimeDialog.draftTimes,
      { classMinutes: 40, breakMinutes: 10 },
      Object.fromEntries(controller.state.periodTimeDialog.segmentConfig.segments.map(segment => [segment.id, segment])),
    );

    await controller.savePeriodTimes();

    assert.deepEqual(calls[0].body.periodTimeSegments.segments.map(segment => segment.id), [
      'morning',
      'evening-study__p1',
      'evening-study__p2',
    ]);
    assert.deepEqual(calls[0].body.dutyAssignments.map(item => item.timeBlockId), [
      'evening-study__p1',
      'evening-study__p2',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable period time save reopens with the saved segment timeline instead of stale range draft', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const project = createDefaultTimetableProject({
    activePeriods: [1, 2, 3],
    periodTimes: [
      { period: 1, start: '08:00', end: '08:40' },
      { period: 2, start: '08:50', end: '09:30' },
      { period: 3, start: '09:40', end: '10:20' },
    ],
  });

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          data: {
            project: createDefaultTimetableProject({
              ...project,
              ...body,
            }),
          },
        };
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.setMessage = () => {};
    controller.applyProject(project);

    controller.openPeriodTimeDialog();
    controller.applySegmentTemplate('withMorningEvening');
    controller.state.container = createPeriodTimeDom(
      controller.state.periodTimeDialog.draftTimes,
      { classMinutes: 45, breakMinutes: 10 },
      Object.fromEntries(controller.state.periodTimeDialog.segmentConfig.segments.map(segment => [segment.id, segment])),
    );

    await controller.savePeriodTimes();
    controller.openPeriodTimeDialog();

    assert.equal(controller.state.periodTimeDialog.open, true);
    assert.deepEqual(controller.state.periodTimeDialog.segmentConfig.segments.map(segment => segment.label), [
      '早读',
      '上午时段',
      '下午时段',
      '晚自习1',
      '晚自习2',
    ]);
    assert.deepEqual(controller.state.periodTimeDialog.segmentConfig.segments.map(segment => segment.kind), [
      'duty',
      'teaching',
      'teaching',
      'duty',
      'duty',
    ]);
    assert.deepEqual(controller.state.periodTimeDialog.draftTimes.map(item => item.period), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(controller.state.periodTimeDialog.segmentConfig.segments[0].startTime, '07:20');
    assert.equal(controller.state.periodTimeDialog.draftTimes[0].start, '08:00');
    assert.equal(controller.state.periodTimeDialog.draftTimes[6].end, '16:35');
    assert.deepEqual(controller.state.rangeDraft.periodTimes.map(item => item.period), [1, 2, 3, 4, 5, 6, 7]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable period time save preserves explicit formal evening study', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const project = createDefaultTimetableProject({
    activePeriods: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    periodTimes: [
      { period: 1, start: '08:00', end: '08:40' },
      { period: 2, start: '08:50', end: '09:30' },
      { period: 3, start: '09:40', end: '10:20' },
      { period: 4, start: '10:30', end: '11:10' },
      { period: 5, start: '14:00', end: '14:40' },
      { period: 6, start: '14:50', end: '15:30' },
      { period: 7, start: '15:40', end: '16:20' },
      { period: 8, start: '19:00', end: '19:45' },
      { period: 9, start: '19:55', end: '20:40' },
    ],
  });

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          data: {
            project: createDefaultTimetableProject({
              ...project,
              ...body,
            }),
          },
        };
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.applyProject(project);
    controller.state.periodTimeDialog = {
      open: true,
      draftTimes: [
        { period: 1, start: '08:00', end: '08:40' },
        { period: 2, start: '08:50', end: '09:30' },
        { period: 3, start: '09:40', end: '10:20' },
        { period: 4, start: '10:30', end: '11:10' },
        { period: 5, start: '14:00', end: '14:40' },
        { period: 6, start: '14:50', end: '15:30' },
        { period: 7, start: '15:40', end: '16:20' },
        { period: 8, start: '19:00', end: '19:45' },
        { period: 9, start: '19:55', end: '20:40' },
      ],
      segmentConfig: {
        globalDefaults: { classMinutes: 40, breakMinutes: 10 },
        segments: [
          { id: 'early-study', label: '早读', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
          { id: 'morning', label: '上午', startTime: '08:00', periodCount: 4, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
          { id: 'afternoon', label: '下午', startTime: '14:00', periodCount: 3, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
          { id: 'evening-study', label: '晚自习', startTime: '19:00', periodCount: 2, classMinutes: 45, breakMinutes: 10, kind: 'teaching' },
        ],
      },
      errors: [{ period: 10, message: '请补齐开始和结束时间' }],
    };
    controller.state.container = createPeriodTimeDom([
      { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
      { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
      { period: 3, start: '09:40', end: '10:20', gapAfter: 10 },
      { period: 4, start: '10:30', end: '11:10', gapAfter: 170 },
      { period: 5, start: '14:00', end: '14:40', gapAfter: 10 },
      { period: 6, start: '14:50', end: '15:30', gapAfter: 10 },
      { period: 7, start: '15:40', end: '16:20', gapAfter: 160 },
      { period: 8, start: '19:00', end: '19:45', gapAfter: 10 },
      { period: 9, start: '19:55', end: '20:40' },
    ], { classMinutes: 40, breakMinutes: 10 }, {
      'early-study': { label: '早读', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
      morning: { label: '上午', startTime: '08:00', periodCount: 4, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
      afternoon: { label: '下午', startTime: '14:00', periodCount: 3, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
      'evening-study': { label: '晚自习', startTime: '19:00', periodCount: 2, classMinutes: 45, breakMinutes: 10, kind: 'teaching' },
    });

    await controller.savePeriodTimes();

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.periodTimes.map(item => item.period), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(calls[0].body.periodTimeSegments.segments.map(segment => segment.kind), [
      'duty',
      'teaching',
      'teaching',
      'teaching',
    ]);
    assert.deepEqual(controller.state.periodTimeDialog.errors || [], []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable period time dialog drafts fill, clear and save through project payload', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const schedule = {
    source: 'fast_constructed',
    slots: [{ id: 'slot_1', classId: 'c1', subjectId: 'math', teacherId: 't_math', day: 1, period: 1 }],
  };
  const project = createDefaultTimetableProject({
    activePeriods: [1, 2, 3],
    periodTimes: [{ period: 1, start: '07:55', end: '08:35' }],
    schedule,
  });

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/project')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              project: createDefaultTimetableProject({
                ...project,
                ...body,
                schedule,
              }),
            },
          };
        },
      };
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.applyProject(project);
    controller.state.solverJob = { jobId: 'job_keep', status: 'running' };
    controller.state.ruleDraftPreview = [{ id: 'draft_keep', status: 'needs_review' }];
    controller.state.ruleWarnings = ['warning_keep'];

    controller.openPeriodTimeDialog();
    assert.equal(controller.state.periodTimeDialog.open, true);
    assert.ok(controller.state.periodTimeDialog.segmentConfig);
    assert.equal(controller.state.periodTimeDialog.segmentConfig.globalDefaults.classMinutes, 40);
    assert.deepEqual(controller.state.periodTimeDialog.draftTimes, [
      { period: 1, start: '07:55', end: '08:35' },
      { period: 2, start: '08:45', end: '09:25', manualOverride: false, segmentLabel: '上午时段' },
      { period: 3, start: '09:35', end: '10:15', manualOverride: false, segmentLabel: '上午时段' },
    ]);

    controller.autoFillPeriodTimes();
    assert.equal(calls.length, 0);
    assert.ok(controller.state.periodTimeDialog.segmentConfig);
    assert.equal(controller.state.periodTimeDialog.segmentConfig.globalDefaults.classMinutes, 45);
    assert.equal(controller.state.periodTimeDialog.draftTimes.length, 3);
    assert.deepEqual(controller.state.periodTimeDialog.draftTimes[0], { period: 1, start: '08:00', end: '08:45', manualOverride: false, segmentLabel: '上午时段' });

    controller.clearPeriodTimes();
    assert.deepEqual(controller.state.periodTimeDialog.draftTimes, []);

    controller.state.periodTimeDialog.draftTimes = [
      { period: 1, start: '08:10', end: '08:50' },
      { period: 2, start: '09:00', end: '09:40' },
      { period: 3, start: '09:50', end: '10:30' },
    ];
    await controller.savePeriodTimes();

    const projectSave = calls.find(call => call.url.endsWith('/project'));
    assert.ok(projectSave);
    assert.deepEqual(projectSave.body.periodTimes, [
      { period: 1, start: '08:10', end: '08:50' },
      { period: 2, start: '09:00', end: '09:40' },
      { period: 3, start: '09:50', end: '10:30' },
    ]);
    assert.ok(projectSave.body.periodTimeSegments);
    assert.ok(projectSave.body.dayPartBoundaries);
    assert.equal(projectSave.body.activePeriods, undefined);
    assert.equal(projectSave.body.activeWeekdays, undefined);
    assert.equal(controller.state.periodTimeDialog.open, false);
    assert.deepEqual(controller.state.solverJob, { jobId: 'job_keep', status: 'running' });
    assert.deepEqual(controller.state.ruleDraftPreview, [{ id: 'draft_keep', status: 'needs_review' }]);
    assert.deepEqual(controller.state.ruleWarnings, ['warning_keep']);
    assert.equal(controller.state.project.schedule.slots.length, 1);
    assert.equal(controller.state.project.schedule.slots[0].id, 'slot_1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable period time settings generate preview drafts from quick settings', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('quick setting edits should update the draft without rerendering the modal');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3] }));
  controller.render = () => {};
  controller.openPeriodTimeDialog();
  controller.render = () => {
    throw new Error('quick setting edits should update the draft without rerendering the modal');
  };

  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
    { period: 3, start: '09:40', end: '10:20' },
  ], { startTime: '08:10', classMinutes: 35, breakMinutes: 5 });
  controller.state.container = dom;

  controller.updatePeriodTimeSettingsFromForm();
  assert.deepEqual(controller.state.periodTimeDialog.settings, {
    startTime: '08:10',
    classMinutes: 35,
    breakMinutes: 5,
    afternoonStartPeriod: null,
    afternoonStartTime: '14:00',
    eveningStartPeriod: null,
    eveningStartTime: '19:00',
  });
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes, [
    { period: 1, start: '08:10', end: '08:45' },
    { period: 2, start: '08:50', end: '09:25' },
    { period: 3, start: '09:30', end: '10:05' },
  ]);
  assert.equal(dom.rows[0].startInput.value, '08:10');
  assert.equal(dom.rows[1].startInput.value, '08:50');
  assert.equal(dom.rows[2].endInput.value, '10:05');
});

test('timetable period time settings generate afternoon-anchored drafts without rerendering the modal', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('segmented quick setting edits should update the draft without rerendering the modal');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3, 4, 5, 6, 7] }));
  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
    { period: 3, start: '09:40', end: '10:20', gapAfter: 10 },
    { period: 4, start: '10:30', end: '11:10', gapAfter: 10 },
    { period: 5, start: '14:00', end: '14:40', gapAfter: 10 },
    { period: 6, start: '14:50', end: '15:30', gapAfter: 10 },
    { period: 7, start: '15:40', end: '16:20' },
  ], {
    startTime: '08:00',
    classMinutes: 40,
    breakMinutes: 10,
    afternoonStartPeriod: 5,
    afternoonStartTime: '14:00',
  });
  controller.state.container = dom;

  controller.updatePeriodTimeSettingsFromForm();

  assert.deepEqual(controller.state.periodTimeDialog.settings, {
    startTime: '08:00',
    classMinutes: 40,
    breakMinutes: 10,
    afternoonStartPeriod: 5,
    afternoonStartTime: '14:00',
    eveningStartPeriod: null,
    eveningStartTime: '19:00',
  });
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes[3], { period: 4, start: '10:30', end: '11:10' });
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes[4], { period: 5, start: '14:00', end: '14:40' });
  assert.equal(dom.rows[4].startInput.value, '14:00');
});

test('timetable period time settings generate evening-anchored drafts without rerendering the modal', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('evening quick setting edits should update the draft without rerendering the modal');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }));
  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:45', gapAfter: 10 },
    { period: 2, start: '08:55', end: '09:40', gapAfter: 10 },
    { period: 3, start: '09:50', end: '10:35', gapAfter: 10 },
    { period: 4, start: '10:45', end: '11:30', gapAfter: 10 },
    { period: 5, start: '14:00', end: '14:45', gapAfter: 10 },
    { period: 6, start: '14:55', end: '15:40', gapAfter: 10 },
    { period: 7, start: '15:50', end: '16:35', gapAfter: 10 },
    { period: 8, start: '19:00', end: '19:45', gapAfter: 10 },
    { period: 9, start: '19:55', end: '20:40', gapAfter: 10 },
    { period: 10, start: '20:50', end: '21:35' },
  ], {
    startTime: '08:00',
    classMinutes: 45,
    breakMinutes: 10,
    afternoonStartPeriod: 5,
    afternoonStartTime: '14:00',
    eveningStartPeriod: 8,
    eveningStartTime: '19:00',
  });
  controller.state.container = dom;

  controller.updatePeriodTimeSettingsFromForm();

  assert.deepEqual(controller.state.periodTimeDialog.draftTimes[4], { period: 5, start: '14:00', end: '14:45' });
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes[7], { period: 8, start: '19:00', end: '19:45' });
  assert.equal(dom.settings.get('#tt-period-evening-start-time').disabled, false);
});

test('timetable period time settings let afternoon boundary be cleared without snapping back to midpoint', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('clearing the afternoon boundary should update the draft without rerendering the modal');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3, 4, 5, 6, 7] }));
  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
    { period: 3, start: '09:40', end: '10:20', gapAfter: 10 },
    { period: 4, start: '10:30', end: '11:10', gapAfter: 10 },
    { period: 5, start: '11:20', end: '12:00', gapAfter: 10 },
    { period: 6, start: '19:00', end: '19:40', gapAfter: 10 },
    { period: 7, start: '19:50', end: '20:30' },
  ], {
    startTime: '08:00',
    classMinutes: 40,
    breakMinutes: 10,
    afternoonStartPeriod: '',
    afternoonStartTime: '14:00',
    eveningStartPeriod: 6,
    eveningStartTime: '19:00',
  });
  controller.state.container = dom;

  controller.updatePeriodTimeSettingsFromForm();

  assert.equal(controller.state.periodTimeDialog.settings.afternoonStartPeriod, null);
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes[4], { period: 5, start: '11:20', end: '12:00' });
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes[5], { period: 6, start: '19:00', end: '19:40' });
});

test('timetable period time settings narrow evening options after afternoon boundary changes', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('boundary option updates should not rerender the modal');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3, 4, 5, 6, 7] }));
  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
    { period: 3, start: '09:40', end: '10:20', gapAfter: 10 },
    { period: 4, start: '10:30', end: '11:10', gapAfter: 10 },
    { period: 5, start: '11:20', end: '12:00', gapAfter: 10 },
    { period: 6, start: '14:00', end: '14:40', gapAfter: 10 },
    { period: 7, start: '19:00', end: '19:40' },
  ], {
    startTime: '08:00',
    classMinutes: 40,
    breakMinutes: 10,
    afternoonStartPeriod: 6,
    afternoonStartTime: '14:00',
    eveningStartPeriod: '',
    eveningStartTime: '19:00',
  });
  controller.state.container = dom;

  controller.updatePeriodTimeSettingsFromForm();

  assert.deepEqual(
    dom.settings.get('#tt-period-evening-start-period').options.map(option => option.value),
    ['', '7'],
  );
  assert.equal(dom.settings.get('#tt-period-evening-start-period').value, '');
});

test('timetable period time gap edits shift following periods without rerendering the modal', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('gap edits should not rerender the whole dialog');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3, 4] }));
  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 25 },
    { period: 3, start: '09:40', end: '10:20', gapAfter: 10 },
    { period: 4, start: '10:30', end: '11:10' },
  ]);
  controller.state.container = dom;
  controller.state.periodTimeDialog = {
    ...controller.state.periodTimeDialog,
    open: true,
    settings: { startTime: '08:00', classMinutes: 40, breakMinutes: 10 },
  };

  controller.updatePeriodTimeGapFromDom(dom.rows[1].gapInput);

  assert.equal(dom.rows[2].startInput.value, '09:55');
  assert.equal(dom.rows[2].endInput.value, '10:35');
  assert.equal(dom.rows[3].startInput.value, '10:45');
  assert.equal(dom.rows[3].endInput.value, '11:25');
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes, [
    { period: 1, start: '08:00', end: '08:40' },
    { period: 2, start: '08:50', end: '09:30' },
    { period: 3, start: '09:55', end: '10:35' },
    { period: 4, start: '10:45', end: '11:25' },
  ]);
});

test('timetable period time manual start and end edits refresh adjacent gap values', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('manual time edits should not rerender the whole dialog');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3] }));
  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
    { period: 3, start: '09:40', end: '10:20' },
  ]);
  controller.state.container = dom;
  controller.state.periodTimeDialog = { ...controller.state.periodTimeDialog, open: true };

  dom.rows[1].startInput.value = '09:00';
  controller.readPeriodTimesFromDom();
  controller.refreshPeriodTimeGapInputsFromDom();

  assert.equal(dom.rows[0].gapInput.value, '20');
  assert.equal(dom.rows[1].gapInput.value, '10');

  dom.rows[1].endInput.value = '09:35';
  controller.readPeriodTimesFromDom();
  controller.refreshPeriodTimeGapInputsFromDom();

  assert.equal(dom.rows[1].gapInput.value, '5');
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes, [
    { period: 1, start: '08:00', end: '08:40' },
    { period: 2, start: '09:00', end: '09:35' },
    { period: 3, start: '09:40', end: '10:20' },
  ]);
});

test('timetable period time save reads live inputs and rejects invalid rows', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const schedule = {
    source: 'fast_constructed',
    slots: [{ id: 'slot_1', classId: 'c1', subjectId: 'math', teacherId: 't_math', day: 1, period: 1 }],
  };
  const project = createDefaultTimetableProject({ activePeriods: [1, 2, 3], schedule });

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      async json() {
        return { success: true, data: { project: createDefaultTimetableProject({ ...project, ...body, schedule }) } };
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.applyProject(project);
    controller.state.periodTimeDialog = { ...controller.state.periodTimeDialog, open: true };
    controller.state.container = createPeriodTimeDom([
      { period: 1, start: '08:05', end: '08:45', gapAfter: 15 },
      { period: 2, start: '09:00', end: '09:40', gapAfter: 10 },
      { period: 3, start: '09:50', end: '10:30' },
    ]);

    await controller.savePeriodTimes();

    assert.deepEqual(calls[0].body.periodTimes, [
      { period: 1, start: '08:05', end: '08:45' },
      { period: 2, start: '09:00', end: '09:40' },
      { period: 3, start: '09:50', end: '10:30' },
    ]);
    assert.equal(controller.state.project.schedule.slots[0].id, 'slot_1');

    calls.length = 0;
    controller.state.periodTimeDialog = { ...controller.state.periodTimeDialog, open: true };
    controller.state.container = createPeriodTimeDom([
      { period: 1, start: '08:40', end: '08:00', gapAfter: 10 },
      { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
      { period: 3, start: '09:40', end: '10:20' },
    ]);

    await controller.savePeriodTimes();

    assert.equal(calls.length, 0);
    assert.equal(controller.state.periodTimeDialog.open, true);
    assert.equal(controller.state.periodTimeDialog.errors[0].period, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable period time save posts explicit afternoon and evening boundaries', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const project = createDefaultTimetableProject({ activePeriods: [1, 2, 3, 4, 5, 6, 7, 8] });

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      async json() {
        return { success: true, data: { project: createDefaultTimetableProject({ ...project, ...body }) } };
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.applyProject(project);
    controller.state.periodTimeDialog = {
      ...controller.state.periodTimeDialog,
      open: true,
      segmentConfig: {
        globalDefaults: { classMinutes: 40, breakMinutes: 10 },
        segments: [
          { id: 'seg-1', label: '上午', startTime: '08:00', periodCount: 4, classMinutes: null, breakMinutes: null },
          { id: 'seg-2', label: '下午', startTime: '14:00', periodCount: 2, classMinutes: null, breakMinutes: null },
          { id: 'seg-3', label: '晚间', startTime: '19:00', periodCount: 2, classMinutes: null, breakMinutes: null },
        ],
      },
    };
    controller.state.container = createPeriodTimeDom([
      { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
      { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
      { period: 3, start: '09:40', end: '10:20', gapAfter: 10 },
      { period: 4, start: '10:30', end: '11:10', gapAfter: 10 },
      { period: 5, start: '14:00', end: '14:40', gapAfter: 10 },
      { period: 6, start: '14:50', end: '15:30', gapAfter: 10 },
      { period: 7, start: '19:00', end: '19:40', gapAfter: 10 },
      { period: 8, start: '19:50', end: '20:30' },
    ], {}, { 'seg-1': { label: '上午', startTime: '08:00', periodCount: 4 }, 'seg-2': { label: '下午', startTime: '14:00', periodCount: 2 }, 'seg-3': { label: '晚间', startTime: '19:00', periodCount: 2 } });

    await controller.savePeriodTimes();

    assert.ok(calls[0].body.dayPartBoundaries);
    assert.equal(calls[0].body.dayPartBoundaries.afternoonStartPeriod, 5);
    assert.equal(calls[0].body.dayPartBoundaries.eveningStartPeriod, 7);
    assert.ok(calls[0].body.periodTimeSegments);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable period time save blocks incomplete, invalid and overlapping rows', async () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3] }));
  const cases = [
    {
      rows: [
        { period: 1, start: '08:00', end: '', gapAfter: 10 },
        { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
        { period: 3, start: '09:40', end: '10:20' },
      ],
      period: 1,
      message: /请补齐开始和结束时间/,
    },
    {
      rows: [
        { period: 1, start: '25:00', end: '08:40', gapAfter: 10 },
        { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
        { period: 3, start: '09:40', end: '10:20' },
      ],
      period: 1,
      message: /时间格式无效/,
    },
    {
      rows: [
        { period: 1, start: '08:00', end: '08:40', gapAfter: -5 },
        { period: 2, start: '08:35', end: '09:15', gapAfter: 10 },
        { period: 3, start: '09:25', end: '10:05' },
      ],
      period: 2,
      message: /后一节不能早于前一节结束/,
    },
  ];

  for (const item of cases) {
    controller.state.periodTimeDialog = { ...controller.state.periodTimeDialog, open: true, errors: [] };
    controller.state.container = createPeriodTimeDom(item.rows);
    await controller.savePeriodTimes();
    assert.equal(controller.state.periodTimeDialog.open, true);
    assert.equal(controller.state.periodTimeDialog.errors[0].period, item.period);
    assert.match(controller.state.periodTimeDialog.errors[0].message, item.message);
  }
});

test('timetable period time save failure keeps the dialog draft editable', async () => {
  const originalFetch = globalThis.fetch;
  const schedule = {
    source: 'fast_constructed',
    slots: [{ id: 'slot_1', classId: 'c1', subjectId: 'math', teacherId: 't_math', day: 1, period: 1 }],
  };
  const project = createDefaultTimetableProject({ activePeriods: [1, 2, 3], schedule });
  globalThis.fetch = async () => {
    throw new Error('project-save-down');
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.applyProject(project);
    controller.state.periodTimeDialog = {
      ...controller.state.periodTimeDialog,
      open: true,
      segmentConfig: {
        globalDefaults: { classMinutes: 40, breakMinutes: 10 },
        segments: [{ id: 'seg-1', label: '全天', startTime: '08:00', periodCount: 3, classMinutes: null, breakMinutes: null }],
      },
    };
    controller.state.container = createPeriodTimeDom([
      { period: 1, start: '08:05', end: '08:45', gapAfter: 15 },
      { period: 2, start: '09:00', end: '09:40', gapAfter: 10 },
      { period: 3, start: '09:50', end: '10:30' },
    ], {}, { 'seg-1': { label: '全天', startTime: '08:00', periodCount: 3 } });

    await controller.savePeriodTimes();

    assert.equal(controller.state.periodTimeDialog.open, true);
    assert.equal(controller.state.periodTimeDialog.saving, false);
    assert.deepEqual(controller.state.periodTimeDialog.draftTimes, [
      { period: 1, start: '08:05', end: '08:45' },
      { period: 2, start: '09:00', end: '09:40' },
      { period: 3, start: '09:50', end: '10:30' },
    ]);
    assert.equal(controller.state.project.schedule.slots[0].id, 'slot_1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable period time clear can be saved and reopened as empty', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const project = createDefaultTimetableProject({
    activePeriods: [1, 2, 3],
    periodTimes: [{ period: 1, start: '08:00', end: '08:40' }],
  });
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      async json() {
        return { success: true, data: { project: createDefaultTimetableProject({ ...project, ...body }) } };
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.applyProject(project);
    controller.openPeriodTimeDialog();
    controller.clearPeriodTimes();
    controller.state.container = createPeriodTimeDom([
      { period: 1, start: '', end: '', gapAfter: '' },
      { period: 2, start: '', end: '', gapAfter: '' },
      { period: 3, start: '', end: '' },
    ]);

    await controller.savePeriodTimes();

    assert.deepEqual(calls[0].body.periodTimes, []);
    assert.equal(controller.state.periodTimeDialog.open, false);
    controller.openPeriodTimeDialog();
    assert.deepEqual(controller.state.periodTimeDialog.draftTimes, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable period time cancel discards unsaved clear draft', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.applyProject(createDefaultTimetableProject({
    activePeriods: [1, 2],
    periodTimes: [{ period: 1, start: '08:00', end: '08:40' }],
  }));

  controller.openPeriodTimeDialog();
  controller.clearPeriodTimes();
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes, []);

  controller.closePeriodTimeDialog();
  controller.openPeriodTimeDialog();

  assert.deepEqual(controller.state.periodTimeDialog.draftTimes, [
    { period: 1, start: '08:00', end: '08:40' },
    { period: 2, start: '08:50', end: '09:30', manualOverride: false, segmentLabel: '上午时段' },
  ]);
});

test('timetable project route only clears schedule when active range changes', async () => {
  const routeSource = await readFile(new URL('../gateway/routes/timetable.js', import.meta.url), 'utf8');

  assert.match(routeSource, /sameNumberList\(current\.activeWeekdays,\s*project\.activeWeekdays\)/);
  assert.match(routeSource, /sameNumberList\(current\.activePeriods,\s*project\.activePeriods\)/);
  assert.doesNotMatch(routeSource, /periodTimes[\s\S]{0,160}preservePublishedArchive\(null,\s*current\.schedule\)/);
  assert.doesNotMatch(routeSource, /dayPartBoundaries[\s\S]{0,200}preservePublishedArchive\(null,\s*current\.schedule\)/);
});

test('timetable inspector keeps data and 智能 rule audit details out of system summaries', () => {
  const state = sampleWorkbenchState({
    ruleDraftPreview: [{
      id: 'draft-1',
      type: 'teacher_unavailable',
      targetName: 'Math Teacher',
      slots: ['3-4'],
      priority: 'hard',
      description: 'Teacher unavailable',
      status: 'ready',
    }],
    ruleWarnings: ['Unknown class ignored'],
    ruleReview: {
      ...sampleWorkbenchState().ruleReview,
      unsupportedItems: [{
        id: 'draft-2',
        type: 'teacher_load_balance',
        targetName: 'All teachers',
        slots: [],
        priority: 'soft',
        description: 'Suggestion only',
        status: 'suggestion',
      }],
    },
  });

  const inspector = renderInspector(state);
  const systemMarkup = inspectorSystemMarkup(inspector);

  assert.match(systemMarkup, /数据摘要/);
  assert.match(systemMarkup, /生成详情/);
  assert.doesNotMatch(inspector, /class="tt-audit-grid"/);
  assert.doesNotMatch(inspector, /tt-rule-preview-item/);
  assert.doesNotMatch(inspector, /Unknown class ignored/);
  assert.doesNotMatch(inspector, /All teachers/);
  assert.doesNotMatch(inspector, /teacher_load_balance/);
});

test('timetable inspector keeps diagnostics issues in main review and system details as summaries', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
      schedule: {
        id: 'schedule_diag',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [],
        conflicts: [],
        unplaced: [],
        audit: null,
        qualityIssues: [],
        score: { totalLessons: 2, placedLessons: 0, unplacedLessons: 2 },
        diagnostics: {
          diagnosticsVersion: 1,
          summary: { error: 1, warning: 1, info: 0, total: 2, suggestions: 1 },
          items: [{
            id: 'diag_1',
            category: 'unplaced',
            type: 'unplaced',
            severity: 'error',
            targetKind: 'class',
            targetId: 'c1',
            targetName: 'G71',
            message: 'Math 还有 2 节未排。',
          }, {
            id: 'diag_2',
            category: 'quality',
            type: 'subject_avoid_period',
            severity: 'warning',
            targetKind: 'subject',
            targetId: 'math',
            targetName: 'Math',
            message: 'Math 排在了避开节次。',
          }],
          byObject: { teachers: {}, classes: { c1: ['diag_1'] }, subjects: { math: ['diag_2'] }, rooms: {}, plans: {} },
          suggestions: [{
            id: 'sug_1',
            kind: 'unplaced',
            targetDiagnostics: ['diag_1'],
            targetName: 'G71',
            message: '检查班级容量后重新生成。',
            applied: false,
          }],
        },
      },
    }),
  });

  const inspector = renderInspector(state);
  const systemMarkup = inspectorSystemMarkup(inspector);

  assert.match(inspector, /tt-inspector-problem-group is-error/);
  assert.match(inspector, /tt-inspector-problem-group is-warning/);
  assert.match(inspector, /Math 还有 2 节未排。/);
  assert.match(inspector, /Math 排在了避开节次。/);
  assert.match(systemMarkup, /数据摘要/);
  assert.match(systemMarkup, /生成详情/);
  assert.doesNotMatch(systemMarkup, /诊断报告/);
  assert.doesNotMatch(systemMarkup, /诊断明细/);
  assert.doesNotMatch(systemMarkup, /诊断建议/);
  assert.doesNotMatch(systemMarkup, /检查班级容量后重新生成。/);
});

test('timetable inspector prefers unified publication diagnostics in main review without system duplication', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      schedule: {
        id: 'publication-diagnostics',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [{ lessonPlanId: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', reason: 'missing slots' }],
        publication: {
          ok: false,
          reason: 'publication_blocked',
          blockingIssues: [{ type: 'incomplete_schedule', message: '还有课时未排入课表。' }],
          warnings: [{ type: 'manual_review', message: '请教务复核。' }],
          reviewItems: [],
          summary: { totalLessons: 3, placedLessons: 1, unplacedLessons: 2, hardConflicts: 0 },
        },
        diagnostics: {
          diagnosticsVersion: 1,
          summary: { error: 1, warning: 1, info: 0, total: 2, suggestions: 0 },
          items: [{
            id: 'diag_pub_1',
            category: 'publication',
            type: 'incomplete_schedule',
            severity: 'error',
            targetKind: 'class',
            targetId: 'c1',
            targetName: 'G71',
            message: 'G71 还有 2 节未排。',
            slot: '',
            objects: { teachers: [], classes: ['c1'], subjects: [], rooms: [], plans: [] },
          }, {
            id: 'diag_pub_2',
            category: 'publication',
            type: 'teacher_load',
            severity: 'warning',
            targetKind: 'teacher',
            targetId: 't_math',
            targetName: 'Math Teacher',
            message: 'Math Teacher 负载接近满载。',
            slot: '',
            objects: { teachers: ['t_math'], classes: [], subjects: [], rooms: [], plans: [] },
          }],
          byObject: { teachers: { t_math: ['diag_pub_2'] }, classes: { c1: ['diag_pub_1'] }, subjects: {}, rooms: {}, plans: {} },
          suggestions: [],
        },
        score: { hardConflicts: 0, unplacedLessons: 2, placedLessons: 1, totalLessons: 3, completeness: 33 },
      },
    }),
  });

  const inspector = renderInspector(state);
  const systemMarkup = inspectorSystemMarkup(inspector);

  assert.match(inspector, /G71 还有 2 节未排。/);
  assert.match(inspector, /Math Teacher 负载接近满载。/);
  assert.match(inspector, /tt-inspector-problem-group is-error/);
  assert.match(inspector, /tt-inspector-problem-group is-warning/);
  assert.match(inspector, /tt-inspector-target-row/);
  assert.match(systemMarkup, /发布详情/);
  assert.match(systemMarkup, /发布校验/);
  assert.doesNotMatch(systemMarkup, /发布问题/);
  assert.doesNotMatch(systemMarkup, /G71 还有 2 节未排。/);
  assert.doesNotMatch(systemMarkup, /Math Teacher 负载接近满载。/);
});

test('timetable publication panel can fall back to publication issueEntries without diagnostics', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      schedule: {
        id: 'publication-issue-entries',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: {
          ok: false,
          reason: 'publication_blocked',
          blockingIssues: [],
          warnings: [],
          issueEntries: [{
            type: 'incomplete_schedule',
            severity: 'error',
            targetKind: 'class',
            targetId: 'c1',
            targetName: 'G7 1',
            message: 'G7 1 还有 2 节未排。',
          }, {
            type: 'teacher_load',
            severity: 'warning',
            targetKind: 'teacher',
            targetId: 't_math',
            targetName: 'Math Teacher',
            message: 'Math Teacher 负载接近满载。',
          }],
          reviewItems: [{
            type: 'teacher_load',
            severity: 'warning',
            targetKind: 'teacher',
            targetId: 't_math',
            targetName: 'Math Teacher',
            message: '旧 reviewItems 文案不该出现。',
          }],
          summary: { totalLessons: 3, placedLessons: 1, unplacedLessons: 2, hardConflicts: 0 },
        },
        score: { hardConflicts: 0, unplacedLessons: 2, placedLessons: 1, totalLessons: 3, completeness: 33 },
      },
    }),
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /G7 1 还有 2 节未排。/);
  assert.match(inspector, /Math Teacher 负载接近满载。/);
  assert.doesNotMatch(inspector, /旧 reviewItems 文案不该出现/);
});

test('timetable publication panel can bridge legacy blockingIssues and warnings without reviewItems', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      schedule: {
        id: 'publication-legacy-lists',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: {
          ok: false,
          reason: 'publication_blocked',
          blockingIssues: [{
            type: 'incomplete_schedule',
            targetKind: 'class',
            targetId: 'c1',
            targetName: 'G7 1',
            message: 'G7 1 还有 2 节未排。',
          }],
          warnings: [{
            type: 'manual_review',
            targetKind: 'schedule',
            targetId: '',
            targetName: '课表',
            message: '请教务复核。',
          }],
          summary: { totalLessons: 3, placedLessons: 1, unplacedLessons: 2, hardConflicts: 0 },
        },
        score: { hardConflicts: 0, unplacedLessons: 2, placedLessons: 1, totalLessons: 3, completeness: 33 },
      },
    }),
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /G7 1 还有 2 节未排。/);
  assert.match(inspector, /请教务复核。/);
  assert.match(inspector, /tt-inspector-problem-group is-error/);
  assert.match(inspector, /tt-inspector-problem-group is-warning/);
});
