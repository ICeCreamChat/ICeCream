import {
    dayName,
    getActivePeriods,
    getActiveWeekdays,
    ownerLabel,
} from '../selectors.js';
import { ruleTypeLabel } from './constraint-adapter.js';

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

const STATUS_LABELS = Object.freeze({
    effective: '可应用',
    needs_review: '需要确认',
    suggestion: '仅作建议',
    unsupported: '暂不支持',
    invalid: '信息不完整',
    ignored: '暂不处理',
});

const RULE_TYPES = [
    'teacher_unavailable',
    'class_unavailable',
    'locked_slot',
    'subject_morning',
    'subject_preferred_periods',
    'subject_avoid_periods',
    'teacher_daily_limit',
    'teacher_consecutive_limit',
    'subject_spread',
];

function renderCheckItems(items, {
    attribute,
    valueFor = item => item.value,
    labelFor = item => item.label,
    extra = '',
    checked = true,
    disabled = false,
} = {}) {
    return items.map(item => `
        <label class="tt-check-chip">
            <input type="checkbox"
                ${attribute}
                value="${escapeAttr(valueFor(item))}"
                ${extra ? `${extra}="${escapeAttr(item.type || '')}"` : ''}
                ${item.name ? `data-target-name="${escapeAttr(item.name)}"` : ''}
                ${checked ? 'checked' : ''}
                ${disabled ? 'disabled' : ''}>
            <span>${escapeHtml(labelFor(item))}</span>
        </label>
    `).join('');
}

function targetGroups(project = {}) {
    return [
        {
            type: 'teacher',
            label: '教师',
            items: (project.teachers || []).map(item => ({ ...item, name: item.name || item.id, type: 'teacher' })),
        },
        {
            type: 'class',
            label: '班级',
            items: (project.classes || []).map(item => ({ ...item, name: ownerLabel(item), type: 'class' })),
        },
        {
            type: 'subject',
            label: '课程',
            items: (project.subjects || []).map(item => ({ ...item, name: item.name || item.id, type: 'subject' })),
        },
    ];
}

export function renderWorkbenchManualBuilder(state = {}, disabled = false) {
    const project = state.project || {};
    const weekdays = getActiveWeekdays(project).map(value => ({ value, label: `周${dayName(value)}` }));
    const periods = getActivePeriods(project).map(value => ({ value, label: `第${value}节` }));
    return `
        <section class="tt-smart-manual-builder">
            <div class="tt-smart-manual-basics">
                <label>
                    <span>要添加什么规则</span>
                    <select id="tt-manual-rule-type" ${disabled ? 'disabled' : ''}>
                        ${RULE_TYPES.map(type => `<option value="${type}">${escapeHtml(ruleTypeLabel(type))}</option>`).join('')}
                    </select>
                </label>
                <label>
                    <span>最多几节</span>
                    <input id="tt-manual-rule-limit" type="number" min="1" max="12" value="3" ${disabled ? 'disabled' : ''}>
                    <em>只在“教师每日/连续上限”中使用</em>
                </label>
            </div>
            <div class="tt-smart-manual-help">
                <i data-lucide="info"></i>
                <span>先选对象和时间，再生成草稿。锁定课节需要同时选择班级、课程和教师。</span>
            </div>
            <div class="tt-smart-manual-targets">
                ${targetGroups(project).map(group => `
                    <fieldset>
                        <legend>${escapeHtml(group.label)}</legend>
                        <div class="tt-chip-grid">
                            ${group.items.length
                                ? renderCheckItems(group.items, {
                                    attribute: 'data-manual-rule-target',
                                    valueFor: item => item.id,
                                    labelFor: item => item.name,
                                    extra: 'data-manual-rule-target-type',
                                    checked: false,
                                    disabled,
                                })
                                : '<span class="tt-muted">当前项目还没有这类数据</span>'}
                        </div>
                    </fieldset>
                `).join('')}
            </div>
            <div class="tt-smart-manual-time">
                <fieldset>
                    <legend>适用周几</legend>
                    <div class="tt-chip-grid">
                        ${renderCheckItems(weekdays, {
                            attribute: 'data-manual-rule-day',
                            disabled,
                        })}
                    </div>
                </fieldset>
                <fieldset>
                    <legend>适用节次</legend>
                    <div class="tt-chip-grid">
                        ${renderCheckItems(periods, {
                            attribute: 'data-manual-rule-period',
                            disabled,
                        })}
                    </div>
                </fieldset>
            </div>
        </section>
    `;
}

function normalizeQuestionOptions(options = []) {
    const seen = new Set();
    return (Array.isArray(options) ? options : [])
        .map(option => ({
            label: String(option?.label || option?.name || option?.value || '').trim(),
            value: String(option?.value || option?.id || '').trim(),
        }))
        .filter(option => {
            if (!option.label || !option.value || seen.has(option.value)) return false;
            seen.add(option.value);
            return true;
        });
}

export function renderWorkbenchClarifications(review = {}) {
    const questions = (review.clarifyingQuestions || []).map(question => ({
        ...question,
        options: normalizeQuestionOptions(question.options),
    }));
    if (!questions.length) return '';
    return `
        <section class="tt-smart-clarifications" aria-label="需要补充的信息">
            <header>
                <span><i data-lucide="circle-help"></i><strong>有 ${questions.length} 处需要你确认</strong></span>
                <p>这不是考试题，只是我遇到了重名或缺失对象。确认一次后会继续匹配草稿。</p>
            </header>
            <div class="tt-smart-clarification-list">
                ${questions.map(question => `
                    <article
                        data-rule-clarify-question="${escapeAttr(question.id)}"
                        data-target-type="${escapeAttr(question.targetType || '')}"
                        data-target-text="${escapeAttr(question.targetText || '')}"
                        data-reason="${escapeAttr(question.reason || '')}">
                        <div>
                            <span>原文出现</span>
                            <strong>${escapeHtml(question.targetText || question.question || '未识别内容')}</strong>
                            <em>${escapeHtml(question.reason || '我无法唯一匹配到项目中的对象')}</em>
                        </div>
                        <label>
                            <span>${question.options.length ? '请选择项目里的真实对象' : '当前项目里没有匹配对象，请补充说明或回到任课数据补充'}</span>
                            ${question.options.length ? `
                                <select
                                    data-rule-question-answer="${escapeAttr(question.id)}"
                                    data-rule-clarify-input="${escapeAttr(question.id)}"
                                    data-question-id="${escapeAttr(question.id)}">
                                    <option value="">请选择</option>
                                    ${question.options.map(option => `
                                        <option
                                            data-rule-clarify-option
                                            data-question-id="${escapeAttr(question.id)}"
                                            data-label="${escapeAttr(option.label)}"
                                            value="${escapeAttr(option.value)}">${escapeHtml(option.label)}</option>
                                    `).join('')}
                                </select>
                            ` : `
                                <input
                                    data-rule-question-answer="${escapeAttr(question.id)}"
                                    data-rule-clarify-input="${escapeAttr(question.id)}"
                                    data-question-id="${escapeAttr(question.id)}"
                                    data-label=""
                                    type="text"
                                    placeholder="例如：指七年级数学课程">
                            `}
                        </label>
                    </article>
                `).join('')}
            </div>
            <button class="tt-btn tt-btn--primary tt-btn--sm" type="button" data-action="submit-rule-clarification">
                <i data-lucide="send"></i><span>确认这些对象并继续匹配</span>
            </button>
        </section>
    `;
}

function targetTypeForRule(row = {}) {
    if (
        ['teacher_daily_limit', 'teacher_consecutive_limit'].includes(row.type)
        && !row.targetId
        && String(row.targetName || '').includes('全部')
    ) {
        return 'all_teachers';
    }
    if (row.targetType) return row.targetType;
    if (row.type === 'class_unavailable') return 'class';
    if (String(row.type || '').startsWith('subject_')) return 'subject';
    if (String(row.type || '').startsWith('teacher_')) return 'teacher';
    return 'global';
}

function entityOptions(project = {}, targetType = '') {
    if (targetType === 'teacher') return (project.teachers || []).map(item => ({ id: item.id, name: item.name || item.id }));
    if (targetType === 'class') return (project.classes || []).map(item => ({ id: item.id, name: ownerLabel(item) }));
    if (targetType === 'subject') return (project.subjects || []).map(item => ({ id: item.id, name: item.name || item.id }));
    return [];
}

function renderTargetEditor(row = {}, project = {}, disabled = false) {
    const targetType = targetTypeForRule(row);
    const options = entityOptions(project, targetType);
    if (!options.length || ['global', 'locked_slot', 'all_teachers'].includes(targetType)) {
        return `<input data-rule-review-field="targetName" type="text" value="${escapeAttr(row.targetName || '')}" ${disabled ? 'disabled' : ''}>`;
    }
    const selected = options.find(item => item.id === row.targetId)
        || options.find(item => item.name === row.targetName);
    return `
        <select data-rule-review-field="targetName" data-rule-target-select ${disabled ? 'disabled' : ''}>
            <option value="">请选择</option>
            ${options.map(item => `
                <option
                    value="${escapeAttr(item.name)}"
                    data-target-id="${escapeAttr(item.id)}"
                    ${selected?.id === item.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>
            `).join('')}
        </select>
    `;
}

function renderAdvancedRow(row = {}, project = {}, disabled = false) {
    const targetType = targetTypeForRule(row);
    const targetId = targetType === 'all_teachers' ? '__all_teachers' : row.targetId || '';
    const status = row.status || 'needs_review';
    return `
        <tr class="tt-rule-review-row" data-rule-review-row="${escapeAttr(row.id)}">
            <td>
                <textarea data-rule-review-field="rawText" rows="2" ${disabled ? 'disabled' : ''}>${escapeHtml(row.rawText || row.description || '')}</textarea>
            </td>
            <td>
                <select data-rule-review-field="type" ${disabled ? 'disabled' : ''}>
                    ${RULE_TYPES.map(type => `<option value="${type}" ${row.type === type ? 'selected' : ''}>${escapeHtml(ruleTypeLabel(type))}</option>`).join('')}
                </select>
                <input type="hidden" data-rule-review-field="targetType" value="${escapeAttr(targetType)}">
                <input type="hidden" data-rule-review-field="targetId" value="${escapeAttr(targetId)}">
                <input type="hidden" data-rule-review-field="classId" value="${escapeAttr(row.classId || '')}">
                <input type="hidden" data-rule-review-field="className" value="${escapeAttr(row.className || '')}">
                <input type="hidden" data-rule-review-field="subjectId" value="${escapeAttr(row.subjectId || '')}">
                <input type="hidden" data-rule-review-field="subjectName" value="${escapeAttr(row.subjectName || '')}">
                <input type="hidden" data-rule-review-field="teacherId" value="${escapeAttr(row.teacherId || '')}">
                <input type="hidden" data-rule-review-field="teacherName" value="${escapeAttr(row.teacherName || '')}">
            </td>
            <td>${renderTargetEditor(row, project, disabled)}</td>
            <td>
                <input data-rule-review-field="slots" type="text" value="${escapeAttr((row.slots || []).join(', '))}" placeholder="如 1-2, 3-4" ${disabled ? 'disabled' : ''}>
            </td>
            <td>
                <select data-rule-review-field="priority" ${disabled ? 'disabled' : ''}>
                    <option value="hard" ${row.priority === 'hard' ? 'selected' : ''}>必须满足</option>
                    <option value="soft" ${row.priority !== 'hard' ? 'selected' : ''}>尽量满足</option>
                </select>
            </td>
            <td>
                <select data-rule-review-field="status" ${disabled ? 'disabled' : ''}>
                    ${Object.entries(STATUS_LABELS).map(([value, label]) => `
                        <option value="${value}" ${status === value ? 'selected' : ''}>${escapeHtml(label)}</option>
                    `).join('')}
                </select>
            </td>
            <td>
                <input data-rule-review-field="description" type="text" value="${escapeAttr(row.description || '')}" ${disabled ? 'disabled' : ''}>
            </td>
            <td>
                <button class="tt-icon-btn tt-icon-btn--sm" type="button" data-rule-review-delete-row="${escapeAttr(row.id)}" title="删除草稿" aria-label="删除草稿" ${disabled ? 'disabled' : ''}>
                    <i data-lucide="trash-2"></i>
                </button>
            </td>
        </tr>
    `;
}

export function renderWorkbenchAdvancedEditor(review = {}, project = {}) {
    if (!review.advancedOpen) return '';
    const rows = review.draftRows || [];
    return `
        <section class="tt-smart-advanced-editor" aria-label="高级编辑">
            <header>
                <span><strong>高级编辑</strong><em>适合需要精确修改类型、对象、节次或强弱的用户</em></span>
                <button class="tt-btn tt-btn--sm" id="tt-add-rule-review-row" type="button"><i data-lucide="plus"></i><span>新增一行</span></button>
            </header>
            <div class="tt-smart-advanced-scroll">
                <span class="tt-rule-review-cell" hidden></span>
                <span class="tt-rule-review-cell-main" hidden></span>
                <span class="tt-rule-review-cell-helper" hidden></span>
                <span class="tt-rule-review-action-cell" hidden></span>
                <table class="tt-rule-review-table">
                    <colgroup class="tt-rule-review-cols">
                        <col style="width: 190px">
                        <col style="width: 150px">
                        <col style="width: 150px">
                        <col style="width: 170px">
                        <col style="width: 120px">
                        <col style="width: 130px">
                        <col style="width: 190px">
                        <col style="width: 78px">
                    </colgroup>
                    <thead>
                        <tr>
                            <th>原话</th>
                            <th>规则</th>
                            <th>对象</th>
                            <th>时间</th>
                            <th>强弱</th>
                            <th>状态</th>
                            <th>说明</th>
                            <th>操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map(row => renderAdvancedRow(row, project, Boolean(review.loading))).join('')}
                    </tbody>
                </table>
            </div>
        </section>
    `;
}
