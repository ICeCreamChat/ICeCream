/**
 * timetable-v2 / components / insight-panel.js
 *
 * 洞察助手区（spec「Three-Pane Workbench Shell」/ 决策 5）。只读展示后端 diagnostics：
 *   - summary：error / warning / info 计数概览。
 *   - items：按 severity 分级配色的诊断列表（读 message，不在前端算冲突）。
 *   - suggestions：修复建议，统一标注「建议草稿」（applied:false）。
 *
 * 红线：
 *   - 不 import 任何后端模块。
 *   - 不做冲突判定 / 候选位计算，只渲染传入的 diagnostics。
 *   - suggestions 一律视觉标注为草稿，与已写入项目区分。
 *
 * 用法：
 *   const panel = createInsightPanel({ diagnostics: store.getState().diagnostics });
 *   layout.setAside(panel.el);
 *   store.subscribe((s) => panel.update({ diagnostics: s.diagnostics }));
 */

const STYLE_ID = 'ttv2-insight-panel-style';

const STYLE_TEXT = `
.ttv2-insight { display: flex; flex-direction: column; gap: 12px;
    padding: 12px; box-sizing: border-box; font-size: 14px; color: var(--ttv2-text, #1f2937); }
.ttv2-insight__title { font-size: 15px; font-weight: 600; margin: 0; }
.ttv2-insight__summary { display: flex; gap: 8px; flex-wrap: wrap; }
.ttv2-insight__chip { display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; }
.ttv2-insight__chip--error { background: rgba(220,38,38,.12); color: #b91c1c; }
.ttv2-insight__chip--warning { background: rgba(217,119,6,.14); color: #b45309; }
.ttv2-insight__chip--info { background: rgba(37,99,235,.12); color: #1d4ed8; }
.ttv2-insight__section-title { font-size: 13px; font-weight: 600; margin: 4px 0;
    color: var(--ttv2-text-muted, #6b7280); }
.ttv2-insight__list { list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 6px; }
.ttv2-insight__item { padding: 8px 10px; border-radius: 8px; border-left: 3px solid transparent;
    background: var(--ttv2-surface-alt, #f9fafb); line-height: 1.4; }
.ttv2-insight__item--error { border-left-color: #dc2626; background: rgba(220,38,38,.06); }
.ttv2-insight__item--warning { border-left-color: #d97706; background: rgba(217,119,6,.07); }
.ttv2-insight__item--info { border-left-color: #2563eb; background: rgba(37,99,235,.06); }
.ttv2-insight__item-cat { font-size: 12px; color: var(--ttv2-text-muted, #6b7280); }
.ttv2-insight__sug { padding: 8px 10px; border-radius: 8px;
    background: repeating-linear-gradient(45deg, rgba(124,58,237,.05), rgba(124,58,237,.05) 8px, rgba(124,58,237,.10) 8px, rgba(124,58,237,.10) 16px);
    border: 1px dashed var(--ttv2-draft-border, #a78bfa); }
.ttv2-insight__draft-tag { display: inline-block; margin-right: 6px; padding: 1px 6px;
    border-radius: 4px; font-size: 11px; font-weight: 600;
    background: var(--ttv2-draft-border, #a78bfa); color: #fff; }
.ttv2-insight__empty { color: var(--ttv2-text-muted, #9ca3af); font-size: 13px; }
`;

function ensureStyle() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
}

const SEVERITY_ORDER = ['error', 'warning', 'info'];

/** 把后端 severity 归一到已知三级（未知值兜底为 info），仅用于配色，不改语义。 */
function normalizeSeverity(sev) {
    return SEVERITY_ORDER.includes(sev) ? sev : 'info';
}

/**
 * 创建洞察助手面板。
 * @param {object} [props]
 * @param {object|null} [props.diagnostics] 后端 diagnostics（items/suggestions/summary）
 * @returns {{ el: HTMLElement, update: (next?: object) => void, destroy: () => void }}
 */
export function createInsightPanel(props = {}) {
    ensureStyle();
    let state = { diagnostics: null, ...props };

    const el = document.createElement('section');
    el.className = 'ttv2-insight';
    el.setAttribute('aria-label', '洞察助手');

    const title = document.createElement('h2');
    title.className = 'ttv2-insight__title';
    title.textContent = '洞察助手';

    const summary = document.createElement('div');
    summary.className = 'ttv2-insight__summary';

    const itemsTitle = document.createElement('div');
    itemsTitle.className = 'ttv2-insight__section-title';
    itemsTitle.textContent = '诊断项';
    const itemsList = document.createElement('ul');
    itemsList.className = 'ttv2-insight__list';

    const sugTitle = document.createElement('div');
    sugTitle.className = 'ttv2-insight__section-title';
    sugTitle.textContent = '修复建议';
    const sugList = document.createElement('ul');
    sugList.className = 'ttv2-insight__list';

    el.append(title, summary, itemsTitle, itemsList, sugTitle, sugList);

    function renderSummary(s) {
        summary.replaceChildren();
        const counts = [
            ['error', '错误', s.error || 0],
            ['warning', '警告', s.warning || 0],
            ['info', '提示', s.info || 0],
        ];
        for (const [sev, label, n] of counts) {
            const chip = document.createElement('span');
            chip.className = `ttv2-insight__chip ttv2-insight__chip--${sev}`;
            chip.textContent = `${label} ${n}`;
            summary.append(chip);
        }
    }

    function renderItems(items) {
        itemsList.replaceChildren();
        if (!items.length) {
            const empty = document.createElement('li');
            empty.className = 'ttv2-insight__empty';
            empty.textContent = '暂无诊断项';
            itemsList.append(empty);
            return;
        }
        for (const it of items) {
            const sev = normalizeSeverity(it.severity);
            const li = document.createElement('li');
            li.className = `ttv2-insight__item ttv2-insight__item--${sev}`;
            const cat = document.createElement('div');
            cat.className = 'ttv2-insight__item-cat';
            cat.textContent = it.category || '';
            const msg = document.createElement('div');
            // 只读后端 message，不在前端生成/计算冲突描述。
            msg.textContent = it.message || '';
            li.append(cat, msg);
            itemsList.append(li);
        }
    }

    function renderSuggestions(suggestions) {
        sugList.replaceChildren();
        if (!suggestions.length) {
            const empty = document.createElement('li');
            empty.className = 'ttv2-insight__empty';
            empty.textContent = '暂无建议';
            sugList.append(empty);
            return;
        }
        for (const sug of suggestions) {
            const li = document.createElement('li');
            li.className = 'ttv2-insight__sug';
            // 建议一律标注草稿（applied:false），与已写入项目视觉区分。
            const tag = document.createElement('span');
            tag.className = 'ttv2-insight__draft-tag';
            tag.textContent = '建议草稿';
            const msg = document.createElement('span');
            msg.textContent = sug.message || sug.expectedRelief || '';
            li.append(tag, msg);
            sugList.append(li);
        }
    }

    function render() {
        const d = state.diagnostics || {};
        renderSummary(d.summary || {});
        renderItems(Array.isArray(d.items) ? d.items : []);
        renderSuggestions(Array.isArray(d.suggestions) ? d.suggestions : []);
    }
    render();

    return {
        el,
        update(next = {}) {
            state = { ...state, ...next };
            render();
        },
        destroy() { el.remove(); },
    };
}
