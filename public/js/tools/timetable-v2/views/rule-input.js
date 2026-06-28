/**
 * timetable-v2 / views / rule-input.js
 *
 * 交互主线第 2 步「规则输入」。采集自然语言 / Excel / 手动的**原始输入**，
 * 「解析」把结果作为草稿 dispatch addPendingRule（强制 applied:false），
 * **不直接写项目**。真正写入在「规则审核」页经 api.commitRules。
 *
 * ───────────────────────── 红线 ─────────────────────────
 * - 不 import 任何后端模块；不在前端拼 rule 业务对象、不做校验。
 * - 「解析」只把原始输入收进 pendingRules 草稿（applied:false），不写 project。
 * - 不在前端做冲突 / 可行性计算。
 *
 * 导出 createRuleInputView({ store, api }) → { el, mount(), update(), destroy() }
 */

const STYLE_ID = 'ttv2-view-rule-input-style';
let fieldIdSeq = 0;

const STYLE_TEXT = `
.ttv2-rinput__tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--ttv2-border, #e5e7eb); }
.ttv2-rinput__tab { border: 0; background: transparent; font: inherit; cursor: pointer;
    padding: 8px 14px; color: var(--ttv2-text-muted, #6b7280);
    border-bottom: 2px solid transparent; margin-bottom: -1px; }
.ttv2-rinput__tab--active { color: var(--ttv2-accent, #2563eb); font-weight: 600;
    border-bottom-color: var(--ttv2-accent, #2563eb); }
.ttv2-rinput__pane { display: none; flex-direction: column; gap: 10px; padding-top: 12px; }
.ttv2-rinput__pane--active { display: flex; }
.ttv2-rinput__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.ttv2-rinput__count { font-size: 13px; color: var(--ttv2-text-muted, #6b7280); }
`;

function ensureStyle() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
}

const MODES = [
    { key: 'nl', label: '自然语言' },
    { key: 'excel', label: 'Excel 导入' },
    { key: 'manual', label: '手动录入' },
];

/**
 * 创建规则输入页。
 * @param {object} deps
 * @param {object} deps.store store（写草稿经 addPendingRule，强制 applied:false）
 * @param {object} deps.api   未在本页写项目，仅保留以对齐签名
 */
export function createRuleInputView({ store, api }) {
    ensureStyle();

    const el = document.createElement('section');
    el.className = 'ttv2-view ttv2-view--rule-input';

    const title = document.createElement('h1');
    title.className = 'ttv2-view__title';
    title.textContent = '规则输入';
    const hint = document.createElement('p');
    hint.className = 'ttv2-view__hint';
    hint.textContent = '采集排课规则的原始输入。「解析为草稿」只生成待确认草稿，不写入项目；写入在「规则审核」页确认。';

    const card = document.createElement('div');
    card.className = 'ttv2-view__card';

    // tabs
    const tabs = document.createElement('div');
    tabs.className = 'ttv2-rinput__tabs';
    const panes = {};
    const tabBtns = {};

    // 自然语言原始文本
    const nlPane = document.createElement('div');
    nlPane.className = 'ttv2-rinput__pane';
    const nlTextarea = document.createElement('textarea');
    nlTextarea.className = 'ttv2-view__textarea';
    nlTextarea.placeholder = '用自然语言描述约束，例如：张老师周一全天不排课；主科尽量排上午。';
    nlPane.append(labeledField('自然语言约束（原文交后端解析）', nlTextarea));
    panes.nl = nlPane;

    // Excel 原始文件
    const excelPane = document.createElement('div');
    excelPane.className = 'ttv2-rinput__pane';
    const excelInput = document.createElement('input');
    excelInput.type = 'file';
    excelInput.accept = '.xlsx,.xls,.csv';
    excelPane.append(labeledField('上传约束表（原始文件交后端解析）', excelInput));
    panes.excel = excelPane;

    // 手动录入原始字段
    const manualPane = document.createElement('div');
    manualPane.className = 'ttv2-rinput__pane';
    const grid = document.createElement('div');
    grid.className = 'ttv2-rinput__grid';
    const typeInput = textInput('规则类型（如 teacher_unavailable）');
    const strengthSelect = document.createElement('select');
    strengthSelect.className = 'ttv2-view__textarea';
    strengthSelect.style.minHeight = 'auto';
    for (const [v, t] of [['soft', '软约束 soft'], ['hard', '硬约束 hard']]) {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = t;
        strengthSelect.append(opt);
    }
    grid.append(
        labeledField('规则类型', typeInput),
        labeledField('约束强度', strengthSelect),
    );
    const manualText = document.createElement('textarea');
    manualText.className = 'ttv2-view__textarea';
    manualText.placeholder = '原始描述 / 参数（原文交后端 normalize）';
    manualPane.append(grid, labeledField('描述', manualText));
    panes.manual = manualPane;

    let activeMode = 'nl';
    for (const m of MODES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ttv2-rinput__tab';
        btn.textContent = m.label;
        btn.addEventListener('click', () => setMode(m.key));
        tabs.append(btn);
        tabBtns[m.key] = btn;
    }

    const actionRow = document.createElement('div');
    actionRow.className = 'ttv2-view__row';
    const parseBtn = document.createElement('button');
    parseBtn.type = 'button';
    parseBtn.className = 'ttv2-view__btn';
    parseBtn.textContent = '解析为草稿';
    const gotoReviewBtn = document.createElement('button');
    gotoReviewBtn.type = 'button';
    gotoReviewBtn.className = 'ttv2-view__btn ttv2-view__btn--ghost';
    gotoReviewBtn.textContent = '去规则审核';
    actionRow.append(parseBtn, gotoReviewBtn);

    const msg = document.createElement('div');
    msg.className = 'ttv2-view__msg';
    const count = document.createElement('div');
    count.className = 'ttv2-rinput__count';

    card.append(tabs, nlPane, excelPane, manualPane, actionRow, msg, count);
    el.append(title, hint, card);

    function setMode(mode) {
        activeMode = mode;
        for (const m of MODES) {
            tabBtns[m.key].classList.toggle('ttv2-rinput__tab--active', m.key === mode);
            panes[m.key].classList.toggle('ttv2-rinput__pane--active', m.key === mode);
        }
    }

    function setMsg(text, kind) {
        msg.textContent = text || '';
        msg.classList.toggle('ttv2-view__msg--ok', kind === 'ok');
        msg.classList.toggle('ttv2-view__msg--err', kind === 'err');
    }

    function renderCount() {
        const n = (store.getState().pendingRules || []).length;
        count.textContent = n ? `当前待确认草稿：${n} 条` : '暂无待确认草稿';
    }

    // 解析：把当前模式下的原始输入收进一条草稿（addPendingRule 强制 applied:false）。
    // 注意：这里不解析语义、不拼业务对象，仅打包原始输入，交「规则审核」页 commit 时由后端 normalize。
    function parseToDraft() {
        let draft = null;
        if (activeMode === 'nl') {
            const text = nlTextarea.value.trim();
            if (!text) { setMsg('请输入自然语言约束。', 'err'); return; }
            draft = { kind: 'rule', source: '自然语言', text, type: 'natural_language', nl: text };
            nlTextarea.value = '';
        } else if (activeMode === 'excel') {
            const file = excelInput.files && excelInput.files[0];
            if (!file) { setMsg('请先选择约束表文件。', 'err'); return; }
            draft = { kind: 'rule', source: `Excel:${file.name}`, fileName: file.name, type: 'excel_import' };
            excelInput.value = '';
        } else {
            const type = typeInput.value.trim();
            const text = manualText.value.trim();
            if (!type && !text) { setMsg('请填写规则类型或描述。', 'err'); return; }
            draft = { kind: 'rule', source: '手动录入', type: type || 'manual', strength: strengthSelect.value, text };
            typeInput.value = '';
            manualText.value = '';
        }
        // 草稿只进 pendingRules，applied 由 store 强制为 false。
        store.dispatch('addPendingRule', draft);
        setMsg('已加入待确认草稿，去「规则审核」确认写入。', 'ok');
    }

    parseBtn.addEventListener('click', parseToDraft);
    gotoReviewBtn.addEventListener('click', () => store.dispatch('goStep', 'rule-review'));

    let unsub = null;

    return {
        el,
        mount() {
            setMode('nl');
            unsub = store.subscribe(renderCount);
            renderCount();
        },
        update() { renderCount(); },
        destroy() {
            if (unsub) { unsub(); unsub = null; }
            el.remove();
        },
    };
}

// ───────── 小工具：纯 DOM 表单字段（无业务逻辑） ─────────
function textInput(placeholder) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ttv2-view__textarea';
    input.style.minHeight = 'auto';
    input.placeholder = placeholder || '';
    return input;
}

function labeledField(labelText, control) {
    const field = document.createElement('div');
    field.className = 'ttv2-view__field';
    const label = document.createElement('label');
    label.textContent = labelText;
    if (!control.id) {
        fieldIdSeq += 1;
        control.id = `ttv2-rule-input-field-${fieldIdSeq}`;
    }
    label.htmlFor = control.id;
    field.append(label, control);
    return field;
}
