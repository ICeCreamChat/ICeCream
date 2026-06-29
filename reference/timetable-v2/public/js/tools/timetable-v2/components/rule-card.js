/**
 * timetable-v2 / components / rule-card.js
 *
 * 规则卡片（spec「Assistant Produces Drafts Only」/ 决策 3）。
 * 视觉区分两类规则：
 *   - 已写入规则（applied:true，或后端 project.constraints 中的项）：实底、无草稿标记。
 *   - 草稿（applied:false，来自 store.pendingRules / 助手建议）：虚线 + 不同底色 + 「待确认」标记。
 *
 * 纯 DOM，只读渲染传入的规则对象。可选 onConfirm 把「确认写入」意图转给宿主
 * （宿主再走 api.commitRules → 后端 normalize+validate，组件本身不写入）。
 *
 * 红线：不 import 后端模块；不在前端拼业务对象 / 不做校验，仅展示原始字段与转发意图。
 *
 * 用法：
 *   const card = createRuleCard({ rule: pendingRule,
 *       onConfirm: (rule) => host.confirmRule(rule) });
 *   container.append(card.el);
 *   card.update({ rule: nextRule });
 */

const STYLE_ID = 'ttv2-rule-card-style';

const STYLE_TEXT = `
.ttv2-rule { padding: 12px; border-radius: 10px; border: 1px solid var(--ttv2-border, #e5e7eb);
    background: var(--ttv2-surface, #fff); display: flex; flex-direction: column; gap: 6px;
    font-size: 14px; color: var(--ttv2-text, #1f2937); }
.ttv2-rule--draft { border-style: dashed; border-color: var(--ttv2-draft-border, #a78bfa);
    background: var(--ttv2-draft-bg, #f5f3ff); }
.ttv2-rule__head { display: flex; align-items: center; gap: 8px; }
.ttv2-rule__type { font-weight: 600; }
.ttv2-rule__strength { font-size: 12px; padding: 1px 6px; border-radius: 4px;
    background: rgba(0,0,0,.06); color: var(--ttv2-text-muted, #6b7280); }
.ttv2-rule__tag { margin-left: auto; font-size: 11px; font-weight: 600;
    padding: 2px 8px; border-radius: 4px; }
.ttv2-rule__tag--draft { background: var(--ttv2-draft-border, #a78bfa); color: #fff; }
.ttv2-rule__tag--applied { background: rgba(16,185,129,.15); color: #047857; }
.ttv2-rule__desc { line-height: 1.4; }
.ttv2-rule__source { font-size: 12px; color: var(--ttv2-text-muted, #6b7280); }
.ttv2-rule__actions { display: flex; gap: 8px; margin-top: 4px; }
.ttv2-rule__confirm { border: 0; border-radius: 6px; padding: 6px 12px; font: inherit;
    background: var(--ttv2-accent, #2563eb); color: #fff; cursor: pointer; }
`;

function ensureStyle() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
}

/** 判定是否草稿：applied 显式为 false 即草稿。 */
function isDraft(rule) {
    return rule ? rule.applied === false : false;
}

/**
 * 创建规则卡片。
 * @param {object} [props]
 * @param {object} [props.rule] 规则对象（type/strength/message/source/applied 等原始字段）
 * @param {(rule: object) => void} [props.onConfirm] 草稿「确认写入」意图回调（宿主走 api 写入口）
 * @returns {{ el: HTMLElement, update: (next?: object) => void, destroy: () => void }}
 */
export function createRuleCard(props = {}) {
    ensureStyle();
    let state = { rule: null, onConfirm: null, ...props };

    const el = document.createElement('article');
    el.className = 'ttv2-rule';

    const head = document.createElement('div');
    head.className = 'ttv2-rule__head';
    const typeEl = document.createElement('span');
    typeEl.className = 'ttv2-rule__type';
    const strengthEl = document.createElement('span');
    strengthEl.className = 'ttv2-rule__strength';
    const tag = document.createElement('span');
    tag.className = 'ttv2-rule__tag';
    head.append(typeEl, strengthEl, tag);

    const desc = document.createElement('div');
    desc.className = 'ttv2-rule__desc';
    const source = document.createElement('div');
    source.className = 'ttv2-rule__source';

    const actions = document.createElement('div');
    actions.className = 'ttv2-rule__actions';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'ttv2-rule__confirm';
    confirmBtn.textContent = '确认写入';
    confirmBtn.addEventListener('click', () => {
        if (typeof state.onConfirm === 'function') state.onConfirm(state.rule);
    });
    actions.append(confirmBtn);

    el.append(head, desc, source, actions);

    function render() {
        const rule = state.rule || {};
        const draft = isDraft(rule);

        el.classList.toggle('ttv2-rule--draft', draft);

        typeEl.textContent = rule.type || rule.kind || '规则';
        strengthEl.textContent = rule.strength || '';
        strengthEl.style.display = rule.strength ? '' : 'none';

        tag.classList.toggle('ttv2-rule__tag--draft', draft);
        tag.classList.toggle('ttv2-rule__tag--applied', !draft);
        tag.textContent = draft ? '待确认' : '已写入';

        // 只读后端 / 草稿原文，前端不构造业务描述。
        desc.textContent = rule.message || rule.text || rule.expectedRelief || '';

        source.textContent = rule.source ? `来源：${rule.source}` : '';
        source.style.display = rule.source ? '' : 'none';

        // 仅草稿可触发确认写入；已写入项不显示该操作。
        actions.style.display = draft && typeof state.onConfirm === 'function' ? '' : 'none';
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
