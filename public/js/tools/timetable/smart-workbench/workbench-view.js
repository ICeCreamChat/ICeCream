import { getSavedRuleItems } from '../selectors.js';
import { renderConstraintChatDock } from '../view-chat.js';
import {
    adaptDraftRowsForWorkbench,
    groupWorkbenchConstraints,
} from './constraint-adapter.js';
import {
    renderWorkbenchAdvancedEditor,
    renderWorkbenchClarifications,
    renderWorkbenchManualBuilder,
} from './workbench-components.js';
import { buildSmartDataAudit, deriveSmartWorkbenchStage } from './workbench-state.js';

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
    return escapeHtml(value);
}

function sourceLabel(value = '') {
    const key = String(value || '').trim().toLowerCase();
    return ({
        ai: '智能解析',
        local: '本地解析',
        text: '粘贴文本',
        manual: '手动新增',
        xlsx_constraints: '约束文件',
        xlsx_roster: '任课文件',
    })[key] || value;
}

const STEPS = [
    ['data', '数据检查', ['idle', 'checking_data', 'data_need_fix']],
    ['input', '描述要求', ['ready_for_constraints', 'parsing_constraints']],
    ['review', '处理问题', ['reviewing_constraints', 'waiting_user_confirmation']],
    ['plan', '求解计划', ['building_solve_plan', 'waiting_solve_approval']],
    ['solve', '生成课表', ['solving', 'solution_review']],
    ['finish', '诊断或保存', ['diagnosing', 'finished', 'failed']],
];

function stepIndex(stage) {
    const index = STEPS.findIndex(([, , stages]) => stages.includes(stage));
    return index < 0 ? 0 : index;
}

function renderStepRail(stage) {
    const active = stepIndex(stage);
    return `
        <nav class="tt-smart-step-rail" aria-label="智能排课步骤">
            <div class="tt-smart-rail-brand">
                <i data-lucide="wand-sparkles"></i>
                <span><strong>智能排课助手</strong><em>一步一步完成排课</em></span>
            </div>
            <ol>
                ${STEPS.map(([key, label], index) => `
                    <li class="${index < active ? 'is-done' : index === active ? 'is-active' : ''}">
                        <span>${index < active ? '<i data-lucide="check"></i>' : index + 1}</span>
                        <button type="button" data-action="smart-workbench-step" data-smart-stage-key="${escapeAttr(key)}" ${index > active ? 'disabled' : ''}>
                            ${escapeHtml(label)}
                        </button>
                    </li>
                `).join('')}
            </ol>
            <button class="tt-btn tt-btn--ghost" type="button" data-action="close-smart-workbench">
                <i data-lucide="arrow-left"></i><span>返回课表</span>
            </button>
        </nav>
    `;
}

function renderDataStage(state, stage) {
    const audit = state.smartWorkbench?.dataAudit || buildSmartDataAudit(state.project);
    const loading = stage === 'checking_data';
    return `
        <section class="tt-smart-task-panel" aria-busy="${loading ? 'true' : 'false'}">
            <header>
                <span class="tt-eyebrow">第 1 步</span>
                <h2>${loading ? '正在检查排课数据' : audit.canContinue ? '排课数据可以继续使用' : '先补齐这些排课数据'}</h2>
                <p>${loading ? '我正在核对班级、教师、课程、任课关系和课时。' : '这些数据决定约束能否正确匹配，也决定课表能不能排完整。'}</p>
            </header>
            <div class="tt-smart-audit-grid">
                <span><b>${audit.stats.classCount}</b><em>班级</em></span>
                <span><b>${audit.stats.teacherCount}</b><em>教师</em></span>
                <span><b>${audit.stats.subjectCount}</b><em>课程</em></span>
                <span><b>${audit.stats.totalLessons}</b><em>周课时</em></span>
            </div>
            ${audit.issues.length ? `
                <div class="tt-smart-action-list" role="list">
                    ${audit.issues.map(issue => `<div role="listitem"><i data-lucide="circle-alert"></i><span>${escapeHtml(issue)}</span></div>`).join('')}
                </div>
            ` : '<div class="tt-smart-success"><i data-lucide="badge-check"></i><span>基础数据完整，可以开始描述排课要求。</span></div>'}
            <div class="tt-smart-primary-action">
                <button class="tt-btn tt-btn--primary" type="button" data-action="${audit.canContinue ? 'smart-workbench-continue-input' : 'smart-workbench-recheck'}" ${loading ? 'disabled' : ''}>
                    <i data-lucide="${loading ? 'loader-2' : audit.canContinue ? 'arrow-right' : 'refresh-cw'}" class="${loading ? 'tt-spin' : ''}"></i>
                    <span>${loading ? '检查中' : audit.canContinue ? '开始描述要求' : '我已补充，重新检查'}</span>
                </button>
            </div>
        </section>
    `;
}

function renderInputStage(state, stage) {
    const review = state.ruleReview || {};
    const mode = review.mode || state.smartWorkbench?.sourceMode || 'text';
    const loading = stage === 'parsing_constraints' || review.loading;
    return `
        <section class="tt-smart-task-panel" aria-busy="${loading ? 'true' : 'false'}">
            <header>
                <span class="tt-eyebrow">第 2 步</span>
                <h2>告诉我你的排课要求</h2>
                <p>像和教务同事说话一样描述。我会先理解你的要求，你确认后才会真正生效。</p>
            </header>
            <div class="tt-smart-source-tabs" role="tablist" aria-label="选择约束来源">
                ${[['text', '粘贴文字', 'message-square'], ['file', '上传文件', 'upload'], ['manual', '手动新增', 'list-plus']].map(([key, label, icon]) => `
                    <button class="${mode === key ? 'is-active' : ''}" type="button" data-action="smart-workbench-mode" data-rule-review-mode="${key}" aria-selected="${mode === key ? 'true' : 'false'}" ${loading ? 'disabled' : ''}>
                        <i data-lucide="${icon}"></i><span>${label}</span>
                    </button>
                `).join('')}
            </div>
            ${mode === 'file' ? `
                <label class="tt-smart-upload">
                    <i data-lucide="file-up"></i>
                    <span><strong>${escapeHtml(review.fileName || '选择 TXT、CSV、XLSX 文件')}</strong><em>系统会读取所有工作表和自然语言内容</em></span>
                    <input id="tt-rule-review-file" type="file" accept=".txt,.csv,.xlsx,.xls" ${loading ? 'disabled' : ''}>
                </label>
            ` : mode === 'manual' ? `
                ${renderWorkbenchManualBuilder(state, loading)}
            ` : `
                <label class="tt-smart-prompt">
                    <span>排课要求</span>
                    <textarea id="tt-rule-review-text" rows="8" spellcheck="false" placeholder="例如：张老师周一上午不排课；数学尽量安排在上午；体育避开第一节。" ${loading ? 'disabled' : ''}>${escapeHtml(review.text || '')}</textarea>
                </label>
                <div class="tt-rule-examples">
                    ${['张老师周一上午不排课', '数学尽量安排在上午', '体育避开第一节', '每位教师每天最多 5 节'].map(item => `
                        <button class="tt-rule-example-chip" type="button" data-rule-example="${escapeAttr(item)}">${escapeHtml(item)}</button>
                    `).join('')}
                </div>
            `}
            ${loading ? `
                <div class="tt-process-strip" aria-live="polite">
                    <i data-lucide="loader-2" class="tt-spin"></i>
                    <span><strong>${escapeHtml(review.phaseText || '智能理解中...')}</strong><em>正在匹配当前项目里的教师、班级、课程和节次</em></span>
                </div>
            ` : ''}
            <div class="tt-smart-primary-action">
                ${mode === 'manual' ? `
                    <button class="tt-btn tt-btn--primary" id="tt-add-manual-rule-rows" type="button" ${loading ? 'disabled' : ''}>
                        <i data-lucide="${loading ? 'loader-2' : 'list-plus'}" class="${loading ? 'tt-spin' : ''}"></i>
                        <span>${loading ? '正在整理' : '整理我的要求'}</span>
                    </button>
                ` : `
                    <button class="tt-btn tt-btn--primary" id="tt-rule-review-parse" type="button" ${loading ? 'disabled' : ''}>
                        <i data-lucide="${loading ? 'loader-2' : 'wand-sparkles'}" class="${loading ? 'tt-spin' : ''}"></i>
                        <span>${loading ? '正在理解要求' : '帮我理解这些要求'}</span>
                    </button>
                `}
            </div>
        </section>
    `;
}

function renderConstraintCard(row, section) {
    const taskId = {
        ready: 'ready_to_apply',
        review: 'review_rules',
        conflict: 'handle_conflicts',
        unsupported: 'unsupported_items',
    }[section] || 'review_rules';
    const sourceParts = [
        row.sourceRow ? `第 ${row.sourceRow} 行` : '',
        sourceLabel(row.source) || '',
    ].filter(Boolean);
    return `
        <article class="tt-smart-rule-card tt-smart-rule-card--${escapeAttr(section)}" data-rule-id="${escapeAttr(row.id)}">
            <div class="tt-smart-rule-head">
                <span>${escapeHtml(row.typeLabel)}</span>
                <div><b class="tt-confidence tt-confidence--${escapeAttr(row.confidenceTone)}">${escapeHtml(row.confidenceLabel)}置信</b><em>${escapeHtml(row.strengthLabel)}</em></div>
            </div>
            <span class="tt-smart-rule-understanding-label">系统理解为</span>
            <strong>${escapeHtml(row.understanding)}</strong>
            <p>原话：${escapeHtml(row.sourceText || '手动新增')}</p>
            ${sourceParts.length ? `<p class="tt-smart-rule-source">来源：${escapeHtml(sourceParts.join(' · '))}</p>` : ''}
            <dl>
                <div><dt>对象</dt><dd>${escapeHtml(row.target.name)}</dd></div>
                <div><dt>时间</dt><dd>${escapeHtml(row.time.label)}</dd></div>
            </dl>
            ${(row.warnings || []).length ? `<div class="tt-smart-rule-note"><i data-lucide="info"></i>${escapeHtml(row.warnings[0])}</div>` : ''}
            <div class="tt-rule-card-actions">
                <button class="tt-btn tt-btn--sm" type="button" data-action="rule-task-explain" data-rule-task-id="${escapeAttr(taskId)}"><i data-lucide="message-circle"></i><span>解释</span></button>
                <button class="tt-btn tt-btn--sm" type="button" data-action="rule-card-edit"><i data-lucide="pencil"></i><span>编辑</span></button>
                <button class="tt-btn tt-btn--sm" type="button" data-action="rule-card-effective"><i data-lucide="check"></i><span>设为生效</span></button>
                <button class="tt-icon-btn tt-icon-btn--sm" type="button" data-action="rule-card-ignore" title="暂不处理" aria-label="暂不处理"><i data-lucide="eye-off"></i></button>
                <button class="tt-icon-btn tt-icon-btn--sm" type="button" data-action="rule-card-delete" title="删除这条" aria-label="删除这条"><i data-lucide="trash-2"></i></button>
            </div>
        </article>
    `;
}

function renderSavedConstraints(state, savedItems) {
    return `
        <section class="tt-smart-saved-panel">
            <header>
                <span class="tt-eyebrow">已生效约束</span>
                <h2>当前参与排课的规则</h2>
                <p>这些规则已经写入项目。删除后会使旧课表失效，下一次生成将使用更新后的规则。</p>
            </header>
            <div class="tt-smart-saved-list">
                ${savedItems.length ? savedItems.map(item => `
                    <article>
                        <div>
                            <span>${escapeHtml(item.label || item.type || '排课规则')}</span>
                            <strong>${escapeHtml(item.targetName || '全局')}</strong>
                            <em>${escapeHtml((item.slots || []).join('、') || item.description || '适用于整个排课范围')}</em>
                        </div>
                        <b>${item.priority === 'hard' ? '必须满足' : '尽量满足'}</b>
                        <button class="tt-icon-btn tt-icon-btn--sm" type="button" data-saved-rule-delete="${escapeAttr(item.id)}" title="删除约束" aria-label="删除约束">
                            <i data-lucide="trash-2"></i>
                        </button>
                    </article>
                `).join('') : `
                    <div class="tt-empty-panel"><i data-lucide="list-checks"></i><strong>还没有已生效约束</strong><span>可以先新增排课要求。</span></div>
                `}
            </div>
            <div class="tt-smart-primary-action">
                <button class="tt-btn tt-btn--primary" type="button" data-action="smart-workbench-new-constraint">
                    <i data-lucide="plus"></i><span>新增约束要求</span>
                </button>
            </div>
        </section>
    `;
}

function renderSmartScan(state) {
    const scan = state.constraintScan || null;
    const preview = state.fixPreview || null;
    if (!scan && !preview) {
        return `
            <button class="tt-smart-scan-entry" id="tt-open-smart-helper" type="button">
                <i data-lucide="scan-search"></i>
                <span><strong>检查规则遗漏和冲突</strong><em>在确认前再做一次本地确定性检查</em></span>
            </button>
        `;
    }
    if (scan?.scanning) {
        return `
            <div class="tt-process-strip" aria-live="polite">
                <i data-lucide="loader-2" class="tt-spin"></i>
                <span><strong>${escapeHtml(scan.phase || '正在检查约束...')}</strong><em>不会修改草稿，也不会重绘课表网格</em></span>
            </div>
        `;
    }
    const problems = scan?.problems || [];
    const detail = state.problemDetailDialog?.open ? state.problemDetailDialog.problem : null;
    return `
        ${scan?.error ? `
            <div class="tt-smart-scan-error"><i data-lucide="triangle-alert"></i><span>${escapeHtml(scan.error)}</span><button class="tt-btn tt-btn--sm" type="button" data-action="rescan-smart-helper">重新检查</button></div>
        ` : `
            <section class="tt-smart-scan-results">
                <header>
                    <span><i data-lucide="${problems.length ? 'scan-search' : 'badge-check'}"></i><strong>${problems.length ? `检查发现 ${problems.length} 个事项` : '没有发现新的阻塞问题'}</strong></span>
                    <button class="tt-btn tt-btn--sm" type="button" data-action="rescan-smart-helper"><i data-lucide="refresh-cw"></i><span>重新检查</span></button>
                </header>
                ${problems.length ? `
                    <div>
                        ${problems.slice(0, 6).map(problem => `
                            <article data-scan-problem-id="${escapeAttr(problem.id)}">
                                <span class="tt-smart-scan-tone tt-smart-scan-tone--${escapeAttr(problem.severity || 'info')}">${problem.severity === 'urgent' ? '需要先处理' : problem.severity === 'optimize' ? '可以优化' : '提示'}</span>
                                <strong>${escapeHtml(problem.title || '规则检查事项')}</strong>
                                <p>${escapeHtml(problem.description || problem.message || '请查看原因后决定如何处理。')}</p>
                                <div class="tt-rule-card-actions">
                                    <button class="tt-btn tt-btn--sm" type="button" data-action="view-problem-details" data-problem-id="${escapeAttr(problem.id)}">查看原因</button>
                                    ${problem.autoFixable ? `<button class="tt-btn tt-btn--sm tt-btn--primary" type="button" data-action="apply-fix" data-problem-id="${escapeAttr(problem.id)}">生成修正</button>` : ''}
                                    <button class="tt-btn tt-btn--sm" type="button" data-action="discuss-with-ai" data-problem-id="${escapeAttr(problem.id)}">问智能助手</button>
                                </div>
                                ${detail?.id === problem.id ? `
                                    <section class="tt-smart-scan-detail">
                                        <button class="tt-icon-btn tt-icon-btn--sm" type="button" data-action="close-problem-detail" aria-label="收起原因"><i data-lucide="x"></i></button>
                                        <strong>问题是什么</strong>
                                        <p>${escapeHtml(detail.description || detail.message || '当前规则可能缺少执行所需信息。')}</p>
                                        <strong>建议怎么处理</strong>
                                        <p>${escapeHtml(detail.fixSuggestion || '核对相关对象和时间后再确认生效。')}</p>
                                    </section>
                                ` : ''}
                            </article>
                        `).join('')}
                    </div>
                ` : ''}
            </section>
        `}
        ${preview?.open && preview.fix ? `
            <section class="tt-smart-inline-fix">
                <header><i data-lucide="wrench"></i><span><strong>修正预览</strong><em>${escapeHtml(preview.problem?.title || '规则调整')}</em></span></header>
                <div>
                    <span><b>修改前</b>${escapeHtml(preview.fix.preview?.before || '当前草稿')}</span>
                    <i data-lucide="arrow-right"></i>
                    <span><b>准备改成</b>${escapeHtml(preview.fix.preview?.after || '调整后的草稿')}</span>
                </div>
                <p>应用后只会修改待复核草稿，仍需在“核对生效”步骤确认。</p>
                <footer>
                    <button class="tt-btn tt-btn--sm" type="button" data-action="close-preview" ${preview.applying ? 'disabled' : ''}>取消</button>
                    <button class="tt-btn tt-btn--sm tt-btn--primary" type="button" data-action="confirm-fix" data-problem-id="${escapeAttr(preview.problem?.id || '')}" ${preview.applying ? 'disabled' : ''}>
                        <i data-lucide="${preview.applying ? 'loader-2' : 'check'}" class="${preview.applying ? 'tt-spin' : ''}"></i><span>${preview.applying ? '应用中' : '应用到草稿'}</span>
                    </button>
                </footer>
            </section>
        ` : ''}
    `;
}

function countQuestionsByTarget(review = {}, targetType = '') {
    const questions = (review.clarifyingQuestions || [])
        .filter(item => item.targetType === targetType).length;
    const missing = (review.missingInfo || [])
        .filter(item => item.targetType === targetType).length;
    return questions + missing;
}

function genericQuestionCount(review = {}) {
    const questions = (review.clarifyingQuestions || [])
        .filter(item => !item.targetType).length;
    const missing = (review.missingInfo || [])
        .filter(item => !item.targetType).length;
    return questions + missing;
}

function slotIssueCount(review = {}, rows = []) {
    const text = [
        ...(review.missingInfo || []).map(item => item.message || item),
        ...rows.flatMap(row => row.warnings || []),
    ].join('\n');
    const explicit = (review.missingInfo || []).filter(item => /节次|时间|范围/.test(item.message || item)).length;
    return explicit || (/节次|时间|范围/.test(text) ? 1 : 0);
}

function renderReviewTaskChecklist(review = {}, groups = {}, savedItems = [], selected = 'ready') {
    const rows = review.draftRows || [];
    const tasks = [
        {
            id: 'ready_to_apply',
            section: 'ready',
            title: '核对可直接应用',
            detail: '对象和时间都明确，确认后可写入。',
            count: groups.ready?.length || 0,
            icon: 'badge-check',
        },
        {
            id: 'review_rules',
            section: 'review',
            title: '核对需要确认',
            detail: '系统已理解大意，但需要你点开看一下。',
            count: groups.review?.length || 0,
            icon: 'clipboard-pen',
        },
        {
            id: 'confirm_subject_names',
            section: 'review',
            title: '确认课程名称',
            detail: '系统不确定原文对应哪门课程。',
            count: countQuestionsByTarget(review, 'subject'),
            icon: 'book-open',
        },
        {
            id: 'confirm_teacher_names',
            section: 'review',
            title: '确认教师名称',
            detail: '重名或简称需要你确认。',
            count: countQuestionsByTarget(review, 'teacher'),
            icon: 'user-round-check',
        },
        {
            id: 'confirm_class_names',
            section: 'review',
            title: '确认班级名称',
            detail: '班级简称或全部班级需要核对。',
            count: countQuestionsByTarget(review, 'class'),
            icon: 'users-round',
        },
        {
            id: 'confirm_names',
            section: 'review',
            title: '确认名称',
            detail: '系统还不知道这句话对应项目里的哪个对象。',
            count: genericQuestionCount(review),
            icon: 'circle-help',
        },
        {
            id: 'fix_slot_range',
            section: 'review',
            title: '修正节次范围',
            detail: '有些节次不在当前排课范围内。',
            count: slotIssueCount(review, rows),
            icon: 'calendar-clock',
        },
        {
            id: 'handle_conflicts',
            section: 'conflict',
            title: '处理冲突风险',
            detail: '互相打架的规则需要先处理。',
            count: (review.conflicts || []).length + (groups.conflict?.length || 0),
            icon: 'triangle-alert',
        },
        {
            id: 'unsupported_items',
            section: 'unsupported',
            title: '查看暂不支持建议',
            detail: '这些只展示，不会写入排课规则。',
            count: (review.unsupportedItems || []).length + (groups.unsupported?.length || 0),
            icon: 'lightbulb',
        },
        {
            id: 'saved_rules',
            section: 'saved',
            title: '查看已生效约束',
            detail: '已经写入项目的规则可以在这里管理。',
            count: savedItems.length,
            icon: 'clipboard-check',
        },
    ];
    return `
        <section class="tt-smart-task-checklist" aria-label="待办理事项">
            <header>
                <span><i data-lucide="list-checks"></i><strong>待办理事项</strong></span>
                <em>${tasks.filter(task => task.count > 0).length || 0} 件需要关注</em>
            </header>
            <div>
                ${tasks.map(task => `
                    <button class="${selected === task.section ? 'is-active' : ''}" type="button"
                        data-action="smart-workbench-section"
                        data-smart-section="${escapeAttr(task.section)}"
                        data-rule-task-id="${escapeAttr(task.id)}">
                        <i data-lucide="${escapeAttr(task.icon)}"></i>
                        <span><strong>${escapeHtml(task.title)}</strong><em>${escapeHtml(task.detail)}</em></span>
                        <b>${escapeHtml(task.count || 0)}</b>
                    </button>
                `).join('')}
            </div>
        </section>
    `;
}

function renderBlockingConflictSummary(review = {}) {
    const conflicts = (review.conflicts || [])
        .filter(item => item.level === 'blocking' || item.severity === 'blocking');
    if (!conflicts.length) return '';
    return `
        <section class="tt-smart-conflict-summary" role="alert">
            <header><i data-lucide="triangle-alert"></i><strong>需要先处理冲突风险</strong></header>
            ${conflicts.slice(0, 3).map(item => `
                <p>${escapeHtml(item.message || item.suggestion || '有规则互相冲突，暂时不能直接生效。')}</p>
            `).join('')}
        </section>
    `;
}

function renderReviewStage(state) {
    const review = state.ruleReview || {};
    const isBusy = Boolean(review.loading || state.smartWorkbench?.busy);
    const blockingConflicts = (review.conflicts || [])
        .some(item => item.level === 'blocking' || item.severity === 'blocking');
    const rows = adaptDraftRowsForWorkbench(review.draftRows || [], {
        conflicts: review.conflicts || [],
    });
    const groups = groupWorkbenchConstraints(rows);
    const unsupportedExtras = adaptDraftRowsForWorkbench(review.unsupportedItems || [], {});
    const knownUnsupportedIds = new Set(groups.unsupported.map(row => row.id).filter(Boolean));
    unsupportedExtras.forEach(row => {
        if (row.id && knownUnsupportedIds.has(row.id)) return;
        groups.unsupported.push(row);
    });
    const savedItems = getSavedRuleItems(state.project);
    const sections = [
        ['ready', '可直接应用', '这些规则对象和时间都很明确。', groups.ready],
        ['review', '需要确认', '请确认对象、时间或强弱是否正确。', groups.review],
        ['conflict', '存在冲突', '这些规则可能互相打架，建议先处理。', groups.conflict],
        ['unsupported', '暂不支持', '当前只能作为建议展示，不会写入规则。', groups.unsupported],
        ['saved', '已生效约束', '当前已经写入项目并参与排课的规则。', savedItems],
    ];
    const selected = state.smartWorkbench?.selectedSection
        || (!rows.length && savedItems.length ? 'saved' : '')
        || sections.find(([, , , items], index) => index < 4 && items.length)?.[0]
        || 'ready';
    const active = sections.find(([key]) => key === selected) || sections[0];
    if (active[0] === 'saved') return renderSavedConstraints(state, savedItems);
    return `
        <section class="tt-smart-review-panel">
            <header>
                <span class="tt-eyebrow">第 3 步</span>
                <h2>核对系统理解的要求</h2>
                <p>先处理需要确认和冲突的内容，再统一查看将要生效的规则。</p>
            </header>
            ${isBusy ? `
                <div class="tt-process-strip" aria-live="polite">
                    <i data-lucide="loader-2" class="tt-spin"></i>
                    <span><strong>${escapeHtml(review.phaseText || '正在处理约束草稿...')}</strong><em>当前不会保存项目，完成后会回到可编辑状态</em></span>
                </div>
            ` : ''}
            ${renderReviewTaskChecklist(review, groups, savedItems, selected)}
            ${renderBlockingConflictSummary(review)}
            <nav class="tt-smart-review-tabs" aria-label="约束分区">
                ${sections.map(([key, label, , items]) => `
                    <button class="${selected === key ? 'is-active' : ''}" type="button" data-action="smart-workbench-section" data-smart-section="${key}" ${isBusy ? 'disabled' : ''}>
                        <span>${escapeHtml(label)}</span><b>${items.length}</b>
                    </button>
                `).join('')}
            </nav>
            <div class="tt-smart-section-intro"><strong>${escapeHtml(active[1])}</strong><span>${escapeHtml(active[2])}</span></div>
            ${renderWorkbenchClarifications(review)}
            ${renderSmartScan(state)}
            <div class="tt-smart-rule-list" role="list">
                ${active[3].length ? active[3].map(row => renderConstraintCard(row, active[0])).join('') : `
                    <div class="tt-empty-panel"><i data-lucide="check-circle"></i><strong>这一类暂时没有内容</strong><span>可以继续查看其他分区。</span></div>
                `}
            </div>
            <details class="tt-smart-details">
                <summary>解析详情与高级编辑</summary>
                <div>
                    ${(review.warnings || []).map(item => `<p>${escapeHtml(item)}</p>`).join('') || '<p>没有额外解析提醒。</p>'}
                    <button class="tt-btn tt-btn--sm" type="button" data-action="rule-review-toggle-advanced"><i data-lucide="table-properties"></i><span>${review.advancedOpen ? '收起高级编辑' : '打开高级编辑'}</span></button>
                </div>
            </details>
            ${renderWorkbenchAdvancedEditor(review, state.project)}
            <div class="tt-smart-primary-action">
                <button class="tt-btn tt-btn--primary" type="button" data-action="smart-workbench-preview-rules" ${isBusy || blockingConflicts || !rows.length ? 'disabled' : ''}>
                    <i data-lucide="${isBusy ? 'loader-2' : 'list-checks'}" class="${isBusy ? 'tt-spin' : ''}"></i><span>${isBusy ? '处理中' : '核对将要生效的规则'}</span>
                </button>
            </div>
        </section>
    `;
}

function previewItem(item = {}) {
    return item.targetName || item.target?.name || item.description || item.type || '规则';
}

function renderRulePreview(state) {
    const preview = state.smartWorkbench?.ruleChangePreview || {};
    const groups = [
        ['将新增', preview.added || [], 'plus-circle'],
        ['将修改', preview.updated || [], 'pencil'],
        ['将删除', preview.removed || [], 'trash-2'],
        ['不会生效', preview.ignored || [], 'circle-slash'],
    ];
    return `
        <section class="tt-smart-task-panel">
            <header><span class="tt-eyebrow">第 4 步</span><h2>确认规则变化</h2><p>确认后才会写入项目，并参与下一次排课。</p></header>
            <div class="tt-smart-diff">
                ${groups.map(([label, items, icon]) => `
                    <section><h3><i data-lucide="${icon}"></i>${label}<b>${items.length}</b></h3>
                        ${items.length ? items.map(item => `<p>${escapeHtml(previewItem(item.after || item))}</p>`).join('') : '<p class="is-empty">没有内容</p>'}
                    </section>
                `).join('')}
            </div>
            <div class="tt-smart-primary-action">
                <button class="tt-btn" type="button" data-action="smart-workbench-back-review"><i data-lucide="arrow-left"></i><span>返回修改</span></button>
                <button class="tt-btn tt-btn--primary" id="tt-confirm-rule-review" type="button" ${preview.effectiveCount ? '' : 'disabled'}><i data-lucide="check"></i><span>确认应用这些规则</span></button>
            </div>
        </section>
    `;
}

function renderSolvePlan(state) {
    const plan = state.smartWorkbench?.solvePlan || {};
    const building = state.smartWorkbench?.stage === 'building_solve_plan' || state.smartWorkbench?.busy;
    return `
        <section class="tt-smart-task-panel">
            <header><span class="tt-eyebrow">第 5 步</span><h2>${building ? '正在准备排课计划' : '确认本次排课计划'}</h2><p>先保证必须满足的规则，再优化课程时段和教师负载。</p></header>
            ${building ? `<div class="tt-process-strip"><i data-lucide="loader-2" class="tt-spin"></i><span><strong>正在检查下一步</strong><em>只会生成计划，不会自动开始排课</em></span></div>` : ''}
            <div class="tt-smart-plan-list">
                <div><i data-lucide="shield-check"></i><span><strong>必须满足</strong><em>${escapeHtml(plan.hardSummary || '教师、班级、教室不冲突，固定课和不可排时间必须满足')}</em></span></div>
                <div><i data-lucide="sliders-horizontal"></i><span><strong>尽量优化</strong><em>${escapeHtml(plan.softSummary || '课程时段、同科分散、教师日负载和连续课')}</em></span></div>
                <div><i data-lucide="zap"></i><span><strong>生成方式</strong><em>${escapeHtml(plan.strategySummary || '先用本地算法快速生成，再由 Timefold 后台择优')}</em></span></div>
                <div><i data-lucide="shield-alert"></i><span><strong>当前风险</strong><em>${escapeHtml(plan.riskSummary || '生成后仍会进行硬冲突和完整性校验')}</em></span></div>
                ${plan.planner?.reason ? `<div><i data-lucide="route"></i><span><strong>为什么这样安排</strong><em>${escapeHtml(plan.planner.reason)}</em></span></div>` : ''}
            </div>
            <div class="tt-smart-primary-action">
                <button class="tt-btn" type="button" data-action="smart-workbench-back-review"><i data-lucide="arrow-left"></i><span>返回修改规则</span></button>
                <button class="tt-btn tt-btn--primary" type="button" data-action="smart-workbench-run-schedule" ${building ? 'disabled' : ''}><i data-lucide="${building ? 'loader-2' : 'play'}" class="${building ? 'tt-spin' : ''}"></i><span>${building ? '准备中' : '开始生成课表'}</span></button>
            </div>
        </section>
    `;
}

function renderSolvingStage(state) {
    const phase = state.solvePhaseText || '快速生成可用课表中...';
    return `
        <section class="tt-smart-task-panel tt-smart-solving" aria-busy="true">
            <i data-lucide="loader-2" class="tt-spin"></i>
            <h2>${escapeHtml(phase)}</h2>
            <p>当前课表不会被清空。本地方案生成后会立即显示，Timefold 在后台继续优化。</p>
            <div class="tt-process-strip"><span class="tt-process-chip is-active">检查数据</span><span class="tt-process-chip is-active">快速生成</span><span class="tt-process-chip">局部优化</span><span class="tt-process-chip">后台择优</span></div>
        </section>
    `;
}

function renderSolutionStage(state) {
    const candidates = state.smartWorkbench?.candidates || [];
    return `
        <section class="tt-smart-task-panel">
            <header><span class="tt-eyebrow">第 6 步</span><h2>查看生成结果</h2><p>这里只展示真实生成或保存过的方案。</p></header>
            <div class="tt-smart-candidate-list">
                ${candidates.length ? candidates.map((item, index) => `
                    <article class="${index === 0 ? 'is-recommended' : ''}">
                        <span>${index === 0 ? '推荐方案' : escapeHtml(item.label || '候选方案')}</span>
                        <strong>${escapeHtml(item.sourceLabel || item.source || '当前课表')}</strong>
                        <dl><div><dt>硬冲突</dt><dd>${escapeHtml(item.hardConflicts ?? 0)}</dd></div><div><dt>软约束</dt><dd>${escapeHtml(item.softScore ?? 0)}</dd></div><div><dt>完整率</dt><dd>${escapeHtml(item.completeness ?? '100%')}</dd></div></dl>
                    </article>
                `).join('') : '<div class="tt-empty-panel"><strong>当前课表已生成</strong><span>返回课表可查看完整结果和质量审查。</span></div>'}
            </div>
            <div class="tt-smart-primary-action">
                <button class="tt-btn" type="button" data-action="close-smart-workbench"><i data-lucide="table-2"></i><span>查看课表</span></button>
                <button class="tt-btn tt-btn--primary" type="button" data-action="smart-workbench-open-publish"><i data-lucide="save"></i><span>保存为正式课表</span></button>
            </div>
        </section>
    `;
}

function renderDiagnosisStage(state) {
    const diagnosis = state.smartWorkbench?.diagnosis || {};
    const suggestions = diagnosis.suggestions || diagnosis.suggestedRelaxations || [];
    return `
        <section class="tt-smart-task-panel">
            <header><span class="tt-eyebrow">需要处理</span><h2>这次没有得到可保存的课表</h2><p>${escapeHtml(diagnosis.summary || state.smartWorkbench?.error || '系统已保留原课表，并整理了可以尝试的调整。')}</p></header>
            <div class="tt-smart-action-list">
                ${suggestions.length ? suggestions.map((item, index) => `<div><b>${index + 1}</b><span>${escapeHtml(item.label || item.message || item)}</span><button class="tt-btn tt-btn--sm" type="button" data-action="smart-workbench-relax-preview" data-relax-index="${index}">返回调整规则</button></div>`).join('') : '<div><i data-lucide="info"></i><span>建议先返回规则复核，减少互相冲突的必须满足条件。</span></div>'}
            </div>
            <div class="tt-smart-primary-action"><button class="tt-btn tt-btn--primary" type="button" data-action="smart-workbench-back-review"><i data-lucide="arrow-left"></i><span>返回调整规则</span></button></div>
        </section>
    `;
}

function renderStage(state, stage) {
    if (['idle', 'checking_data', 'data_need_fix'].includes(stage)) return renderDataStage(state, stage);
    if (['ready_for_constraints', 'parsing_constraints'].includes(stage)) return renderInputStage(state, stage);
    if (stage === 'reviewing_constraints') return renderReviewStage(state);
    if (stage === 'waiting_user_confirmation') return state.smartWorkbench?.ruleChangePreview
        ? renderRulePreview(state)
        : renderReviewStage(state);
    if (['building_solve_plan', 'waiting_solve_approval'].includes(stage)) return renderSolvePlan(state);
    if (stage === 'solving') return renderSolvingStage(state);
    if (stage === 'solution_review' || stage === 'finished') return renderSolutionStage(state);
    return renderDiagnosisStage(state);
}

function renderInsight(state, stage) {
    const review = state.ruleReview || {};
    const rows = review.draftRows || [];
    const ready = rows.filter(row => row.status === 'effective').length;
    const reviewCount = rows.filter(row => ['needs_review', 'invalid'].includes(row.status)).length;
    const conflicts = (review.conflicts || []).filter(item => item.level === 'blocking').length;
    const saved = getSavedRuleItems(state.project).length;
    return `
        <aside class="tt-smart-insight-rail">
            <header><i data-lucide="lightbulb"></i><span><strong>当前情况</strong><em>只显示这一步需要知道的内容</em></span></header>
            <div class="tt-smart-insight-stats">
                <span><b>${saved}</b><em>已生效</em></span>
                <span><b>${ready}</b><em>可应用</em></span>
                <span><b>${reviewCount + conflicts}</b><em>需处理</em></span>
            </div>
            <section>
                <h3>下一步</h3>
                <p>${escapeHtml({
                    idle: '先检查任课数据是否完整。',
                    checking_data: '检查完成后，我会告诉你能否继续。',
                    data_need_fix: '回到任课数据补齐缺少内容，再重新检查。',
                    ready_for_constraints: '输入要求后点击“帮我理解这些要求”。',
                    parsing_constraints: '正在整理草稿，请稍候。',
                    reviewing_constraints: '逐项核对系统理解，优先处理冲突和不确定内容。',
                    waiting_user_confirmation: state.smartWorkbench?.ruleChangePreview ? '核对规则变化后再确认写入。' : '先完成需要确认的事项。',
                    waiting_solve_approval: '确认求解计划后开始生成课表。',
                    solving: '本地可用方案生成后会立即显示。',
                    solution_review: '查看结果后可返回课表或保存正式版本。',
                    diagnosing: '选择一个调整方向，预览后重新生成。',
                }[stage] || '按中间区域的提示继续。')}</p>
            </section>
            <section class="tt-smart-assistant-slot">
                <h3>智能助手</h3>
                ${state.constraintChat?.open
                    ? renderConstraintChatDock(state, { task: null })
                    : `<button class="tt-smart-assistant-entry" type="button" data-action="constraint-chat-start"><i data-lucide="message-circle"></i><span><strong>有看不懂的地方？</strong><em>我只解释当前步骤，不会直接修改规则。</em></span></button>`}
            </section>
        </aside>
    `;
}

export function renderSmartWorkbench(state = {}) {
    const stage = state.smartWorkbench?.stage && state.smartWorkbench.stage !== 'idle'
        ? state.smartWorkbench.stage
        : deriveSmartWorkbenchStage(state);
    return `
        <section class="tt-smart-workbench" data-smart-workbench-root data-smart-stage="${escapeAttr(stage)}">
            ${renderStepRail(stage)}
            <main class="tt-smart-stage" data-smart-workbench-stage aria-live="polite">
                ${renderStage(state, stage)}
            </main>
            ${renderInsight(state, stage)}
        </section>
    `;
}
