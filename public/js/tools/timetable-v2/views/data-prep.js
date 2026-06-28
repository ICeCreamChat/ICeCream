/**
 * timetable-v2 / views / data-prep.js
 *
 * 交互主线第 1 步「数据准备」。上传 / 编辑任课原始输入，展示当前项目摘要，
 * 洞察区展示数据审计项（diagnostics 中 category==='audit' 的项）。
 *
 * ───────────────────────── 红线 ─────────────────────────
 * - 不 import 任何 gateway/services/timetable-v2 后端模块。
 * - 不在前端构造 project / activity 业务对象；表单只采集原始输入。
 * - 原始输入「提交」只经 api 写入口（mock 回放）→ 后端 normalize。
 * - 不在前端做任何排课 / 冲突 / 可行性计算，只读后端 project / diagnostics 展示。
 *
 * 导出 createDataPrepView({ store, api }) → { el, mount(), update(), destroy() }
 */

const STYLE_ID = 'ttv2-view-data-prep-style';
let fieldIdSeq = 0;

const STYLE_TEXT = `
.ttv2-view { display: flex; flex-direction: column; gap: 16px;
    font-size: 14px; color: var(--ttv2-text, #1f2937); }
.ttv2-view__title { font-size: 18px; font-weight: 600; margin: 0; }
.ttv2-view__hint { color: var(--ttv2-text-muted, #6b7280); font-size: 13px; margin: 0; }
.ttv2-view__card { border: 1px solid var(--ttv2-border, #e5e7eb); border-radius: 10px;
    padding: 12px 14px; background: var(--ttv2-surface, #fff);
    display: flex; flex-direction: column; gap: 10px; }
.ttv2-view__card-title { font-size: 14px; font-weight: 600; margin: 0; }
.ttv2-view__field { display: flex; flex-direction: column; gap: 4px; }
.ttv2-view__field > label { font-size: 13px; color: var(--ttv2-text-muted, #6b7280); }
.ttv2-view__textarea { width: 100%; box-sizing: border-box; min-height: 96px;
    border: 1px solid var(--ttv2-border, #e5e7eb); border-radius: 8px; padding: 8px;
    font: inherit; resize: vertical; }
.ttv2-view__row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ttv2-view__btn { border: 0; border-radius: 6px; padding: 8px 14px; font: inherit;
    background: var(--ttv2-accent, #2563eb); color: #fff; cursor: pointer; }
.ttv2-view__btn:disabled { opacity: .5; cursor: not-allowed; }
.ttv2-view__btn--ghost { background: transparent; color: var(--ttv2-accent, #2563eb);
    border: 1px solid var(--ttv2-border, #e5e7eb); }
.ttv2-view__msg { font-size: 13px; min-height: 18px; }
.ttv2-view__msg--ok { color: #047857; }
.ttv2-view__msg--err { color: #b91c1c; }
.ttv2-view__summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.ttv2-view__stat { border: 1px solid var(--ttv2-border, #e5e7eb); border-radius: 8px;
    padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.ttv2-view__stat-num { font-size: 18px; font-weight: 700; }
.ttv2-view__stat-label { font-size: 12px; color: var(--ttv2-text-muted, #6b7280); }
.ttv2-view__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ttv2-view__audit { padding: 8px 10px; border-radius: 8px; line-height: 1.4;
    background: rgba(37,99,235,.06); border-left: 3px solid #2563eb; }
.ttv2-view__empty { color: var(--ttv2-text-muted, #9ca3af); font-size: 13px; }
`;

function ensureStyle() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
}

function bindLabel(label, control, prefix = 'ttv2-data-prep-field') {
    if (!control.id) {
        fieldIdSeq += 1;
        control.id = `${prefix}-${fieldIdSeq}`;
    }
    label.htmlFor = control.id;
}

/**
 * 创建数据准备页。
 * @param {object} deps
 * @param {object} deps.store store（读 project，写引用经 setProject）
 * @param {object} deps.api   api（getProject / commitRules）
 */
export function createDataPrepView({ store, api }) {
    ensureStyle();

    const el = document.createElement('section');
    el.className = 'ttv2-view ttv2-view--data-prep';

    const title = document.createElement('h1');
    title.className = 'ttv2-view__title';
    title.textContent = '数据准备';
    const hint = document.createElement('p');
    hint.className = 'ttv2-view__hint';
    hint.textContent = '上传或粘贴任课原始输入。前端只采集原文，由后端 normalize 拼装项目与活动。';

    // 原始输入采集卡片（纯原始文本 / 文件，不在前端拼业务对象）。
    const inputCard = document.createElement('div');
    inputCard.className = 'ttv2-view__card';
    const inputTitle = document.createElement('h2');
    inputTitle.className = 'ttv2-view__card-title';
    inputTitle.textContent = '任课原始输入';

    const fileField = document.createElement('div');
    fileField.className = 'ttv2-view__field';
    const fileLabel = document.createElement('label');
    fileLabel.textContent = '上传任课表（Excel / CSV，原始文件交后端解析）';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.xlsx,.xls,.csv';
    bindLabel(fileLabel, fileInput);
    fileField.append(fileLabel, fileInput);

    const textField = document.createElement('div');
    textField.className = 'ttv2-view__field';
    const textLabel = document.createElement('label');
    textLabel.textContent = '或粘贴原始任课文本';
    const textarea = document.createElement('textarea');
    textarea.className = 'ttv2-view__textarea';
    textarea.placeholder = '例如：一班 语文 张老师 每周5节；一班 数学 李老师 每周4节连堂…';
    bindLabel(textLabel, textarea);
    textField.append(textLabel, textarea);

    const actionRow = document.createElement('div');
    actionRow.className = 'ttv2-view__row';
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'ttv2-view__btn';
    submitBtn.textContent = '提交原始输入';
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'ttv2-view__btn ttv2-view__btn--ghost';
    refreshBtn.textContent = '刷新项目摘要';
    actionRow.append(submitBtn, refreshBtn);

    const msg = document.createElement('div');
    msg.className = 'ttv2-view__msg';

    inputCard.append(inputTitle, fileField, textField, actionRow, msg);

    // 当前项目摘要卡片（只读后端 project）。
    const summaryCard = document.createElement('div');
    summaryCard.className = 'ttv2-view__card';
    const summaryTitle = document.createElement('h2');
    summaryTitle.className = 'ttv2-view__card-title';
    summaryTitle.textContent = '当前项目摘要';
    const summaryName = document.createElement('p');
    summaryName.className = 'ttv2-view__hint';
    const summaryGrid = document.createElement('div');
    summaryGrid.className = 'ttv2-view__summary';
    summaryCard.append(summaryTitle, summaryName, summaryGrid);

    // 数据审计卡片（只读 diagnostics 中 audit 项）。
    const auditCard = document.createElement('div');
    auditCard.className = 'ttv2-view__card';
    const auditTitle = document.createElement('h2');
    auditTitle.className = 'ttv2-view__card-title';
    auditTitle.textContent = '数据审计';
    const auditList = document.createElement('ul');
    auditList.className = 'ttv2-view__list';
    auditCard.append(auditTitle, auditList);

    el.append(title, hint, inputCard, summaryCard, auditCard);

    function setMsg(text, kind) {
        msg.textContent = text || '';
        msg.classList.toggle('ttv2-view__msg--ok', kind === 'ok');
        msg.classList.toggle('ttv2-view__msg--err', kind === 'err');
    }

    function stat(num, label) {
        const box = document.createElement('div');
        box.className = 'ttv2-view__stat';
        const n = document.createElement('span');
        n.className = 'ttv2-view__stat-num';
        n.textContent = String(num);
        const l = document.createElement('span');
        l.className = 'ttv2-view__stat-label';
        l.textContent = label;
        box.append(n, l);
        return box;
    }

    function renderSummary() {
        const p = store.getState().project;
        summaryGrid.replaceChildren();
        if (!p) {
            summaryName.textContent = '尚未加载项目。提交原始输入或点击「刷新项目摘要」。';
            return;
        }
        summaryName.textContent = p.name ? `项目：${p.name}` : '项目（未命名）';
        summaryGrid.append(
            stat((p.classes || []).length, '班级'),
            stat((p.teachers || []).length, '教师'),
            stat((p.subjects || []).length, '课程'),
            stat((p.rooms || []).length, '教室'),
            stat((p.activityPlans || []).length, '任课计划'),
            stat((p.constraints || []).length, '已写入规则'),
        );
    }

    function renderAudit() {
        const d = store.getState().diagnostics || {};
        const items = (Array.isArray(d.items) ? d.items : []).filter((it) => it.category === 'audit');
        auditList.replaceChildren();
        if (!items.length) {
            const empty = document.createElement('li');
            empty.className = 'ttv2-view__empty';
            empty.textContent = '暂无数据审计项';
            auditList.append(empty);
            return;
        }
        for (const it of items) {
            const li = document.createElement('li');
            li.className = 'ttv2-view__audit';
            li.textContent = it.message || '';
            auditList.append(li);
        }
    }

    async function loadProject() {
        setMsg('正在加载项目摘要…', null);
        try {
            const project = await api.getProject();
            store.dispatch('setProject', project);
            setMsg('', null);
        } catch (err) {
            setMsg(err.message || '加载项目失败', 'err');
        }
    }

    async function submitRaw() {
        // 只采集原始输入（文件名 / 文本），交后端 normalize；前端不拼业务对象。
        const file = fileInput.files && fileInput.files[0];
        const text = textarea.value.trim();
        if (!file && !text) {
            setMsg('请先上传文件或粘贴任课文本。', 'err');
            return;
        }
        submitBtn.disabled = true;
        setMsg('正在提交原始输入…', null);
        try {
            const rawDraft = {
                kind: 'data-prep',
                source: file ? `file:${file.name}` : 'text',
                rawText: text || undefined,
                fileName: file ? file.name : undefined,
            };
            const project = await api.commitRules({ project: store.getState().project, rules: rawDraft });
            store.dispatch('setProject', project);
            setMsg('原始输入已提交，项目摘要已更新。', 'ok');
        } catch (err) {
            setMsg(err.message || '提交失败', 'err');
        } finally {
            submitBtn.disabled = false;
        }
    }

    submitBtn.addEventListener('click', submitRaw);
    refreshBtn.addEventListener('click', loadProject);

    let unsub = null;

    return {
        el,
        mount() {
            unsub = store.subscribe(() => { renderSummary(); renderAudit(); });
            renderSummary();
            renderAudit();
            // 首次进入若无项目则尝试拉取摘要。
            if (!store.getState().project) loadProject();
        },
        update() { renderSummary(); renderAudit(); },
        destroy() {
            if (unsub) { unsub(); unsub = null; }
            el.remove();
        },
    };
}
