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

const STYLE_TEXT = '';

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
    let state = { diagnostics: null, migrationReport: null, unsupportedRules: [], publishResult: null, ...props };

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

    const reportTitle = document.createElement('div');
    reportTitle.className = 'ttv2-insight__section-title';
    reportTitle.textContent = '导入 / 写入反馈';
    const reportList = document.createElement('ul');
    reportList.className = 'ttv2-insight__list';

    el.append(title, summary, itemsTitle, itemsList, sugTitle, sugList, reportTitle, reportList);

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

    function appendReportItem(text, kind = 'info') {
        const li = document.createElement('li');
        li.className = `ttv2-insight__item ttv2-insight__item--${normalizeSeverity(kind)}`;
        li.textContent = text;
        reportList.append(li);
    }

    function renderReport() {
        reportList.replaceChildren();
        const report = state.migrationReport || {};
        const summaryData = report.summary || null;
        const unsupported = Array.isArray(state.unsupportedRules) ? state.unsupportedRules : [];
        const publish = state.publishResult || null;

        if (summaryData) {
            appendReportItem(`导入报告：保留 ${summaryData.kept || 0}，降级 ${summaryData.degraded || 0}，丢弃 ${summaryData.dropped || 0}，待审 ${summaryData.review || 0}`, summaryData.dropped ? 'warning' : 'info');
        }

        for (const item of unsupported.slice(0, 4)) {
            appendReportItem(`规则未支持：${item.text || item.reason || JSON.stringify(item)}`, 'warning');
        }

        if (publish?.published) {
            appendReportItem(`发布成功：${publish.publishedAt || '已生成发布快照'}`, 'info');
        }

        if (!summaryData && unsupported.length === 0 && !publish) {
            const empty = document.createElement('li');
            empty.className = 'ttv2-insight__empty';
            empty.textContent = '暂无导入或发布反馈';
            reportList.append(empty);
        }
    }

    function render() {
        const d = state.diagnostics || {};
        renderSummary(d.summary || {});
        renderItems(Array.isArray(d.items) ? d.items : []);
        renderSuggestions(Array.isArray(d.suggestions) ? d.suggestions : []);
        renderReport();
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
