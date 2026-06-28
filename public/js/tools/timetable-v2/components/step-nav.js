/**
 * timetable-v2 / components / step-nav.js
 *
 * 步骤导航（spec「Three-Pane Workbench Shell」）：按交互主线顺序展示步骤，
 * 高亮当前 step，点击某步骤时通过 onGoStep 回调把 step 交给宿主 dispatch('goStep', step)。
 *
 * 纯 DOM。组件本身不持有 store，不直接 dispatch；由宿主把 store.dispatch 注入为 onGoStep。
 * 红线：不 import 后端模块，不做任何业务计算，仅渲染步骤与转发点击意图。
 *
 * 用法：
 *   const nav = createStepNav({ current: 'data-prep',
 *       onGoStep: (step) => store.dispatch('goStep', step) });
 *   layout.setNav(nav.el);
 *   store.subscribe((s) => nav.update({ current: s.step }));
 */

// 交互主线步骤顺序（与 spec / 设计一致），label 为面向用户中文。
export const STEPS = [
    { step: 'data-prep', label: '数据准备' },
    { step: 'rule-input', label: '规则输入' },
    { step: 'rule-review', label: '规则审核' },
    { step: 'solve-progress', label: '求解进度' },
    { step: 'result-diagnostics', label: '结果诊断' },
    { step: 'manual-adjust', label: '手动调整' },
    { step: 'publish-export', label: '发布导出' },
];

const STYLE_ID = 'ttv2-step-nav-style';

const STYLE_TEXT = '';

function ensureStyle() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
}

/**
 * 创建步骤导航。
 * @param {object} [props]
 * @param {string} [props.current='data-prep'] 当前步骤 key
 * @param {(step: string) => void} [props.onGoStep] 点击步骤回调（宿主转 dispatch('goStep', step)）
 * @returns {{ el: HTMLElement, update: (next?: object) => void, destroy: () => void }}
 */
export function createStepNav(props = {}) {
    ensureStyle();
    let state = { current: 'data-prep', onGoStep: null, ...props };

    const el = document.createElement('nav');
    el.className = 'ttv2-stepnav-root';
    el.setAttribute('aria-label', '排课步骤导航');

    const list = document.createElement('ul');
    list.className = 'ttv2-stepnav';
    el.append(list);

    const buttons = new Map();
    STEPS.forEach((s, i) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ttv2-stepnav__item';
        btn.dataset.step = s.step;

        const idx = document.createElement('span');
        idx.className = 'ttv2-stepnav__index';
        idx.textContent = String(i + 1);
        const label = document.createElement('span');
        label.className = 'ttv2-stepnav__label';
        label.textContent = s.label;
        btn.append(idx, label);

        btn.addEventListener('click', () => {
            if (typeof state.onGoStep === 'function') state.onGoStep(s.step);
        });
        li.append(btn);
        list.append(li);
        buttons.set(s.step, btn);
    });

    function render() {
        for (const [step, btn] of buttons) {
            const active = step === state.current;
            btn.classList.toggle('ttv2-stepnav__item--active', active);
            if (active) btn.setAttribute('aria-current', 'step');
            else btn.removeAttribute('aria-current');
        }
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
