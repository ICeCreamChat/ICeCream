/**
 * timetable-v2 / components / mobile-drawer.js
 *
 * 窄屏底部抽屉（决策 5 / spec「窄屏降级不遮挡关键操作」）。
 * 一个可开合的底部面板，配一个固定操作栏，确保生成 / 确认写入 / 发布等关键操作
 * 始终可达、不被抽屉内容遮挡。
 *
 * 注意：本组件是一个独立、可复用的抽屉容器（与 three-pane-layout 的内置窄屏抽屉互补，
 * 供需要独立抽屉的页面使用）。纯 DOM，仅做开合与插槽，无业务逻辑。
 *
 * 红线：不 import 后端模块；不读写 solution/diagnostics 业务数据，仅承载子节点。
 *
 * 用法：
 *   const drawer = createMobileDrawer({ open: false, title: '洞察助手',
 *       onToggle: (open) => store.dispatch('setUi', { drawerOpen: open }) });
 *   drawer.setContent(insightPanel.el);
 *   drawer.setActions(actionBarEl);   // 固定操作栏，不被抽屉遮挡
 *   document.body.append(drawer.el);
 */

const STYLE_ID = 'ttv2-mobile-drawer-style';

const STYLE_TEXT = `
.ttv2-drawer { position: fixed; left: 0; right: 0; bottom: 0; z-index: 50; }
.ttv2-drawer__actions { display: flex; gap: 8px; align-items: center;
    padding: 8px 12px; background: var(--ttv2-surface, #fff);
    box-shadow: 0 -2px 8px rgba(0,0,0,.12); position: relative; z-index: 2; }
.ttv2-drawer__handle { margin-left: auto; border: 0; background: transparent;
    font: inherit; color: var(--ttv2-accent, #2563eb); cursor: pointer; padding: 6px 8px; }
.ttv2-drawer__panel { position: absolute; left: 0; right: 0; bottom: 100%;
    max-height: 70vh; overflow-y: auto; background: var(--ttv2-surface, #fff);
    border-radius: 12px 12px 0 0; box-shadow: 0 -8px 24px rgba(0,0,0,.18);
    transform: translateY(100%); transition: transform .2s ease;
    visibility: hidden; }
.ttv2-drawer--open .ttv2-drawer__panel { transform: translateY(0); visibility: visible; }
.ttv2-drawer__title { font-size: 14px; font-weight: 600; padding: 10px 12px 0;
    color: var(--ttv2-text, #1f2937); }
.ttv2-drawer__body { padding: 4px 0 12px; }
`;

function ensureStyle() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
}

/**
 * 创建底部抽屉。
 * @param {object} [props]
 * @param {boolean} [props.open=false] 初始开合
 * @param {string} [props.title=''] 抽屉标题
 * @param {(open: boolean) => void} [props.onToggle] 开合回调
 * @returns {{ el: HTMLElement, update: (next?: object) => void, destroy: () => void,
 *            setContent: (n: Node|null) => void, setActions: (n: Node|null) => void }}
 */
export function createMobileDrawer(props = {}) {
    ensureStyle();
    let state = { open: false, title: '', onToggle: null, ...props };

    const el = document.createElement('div');
    el.className = 'ttv2-drawer';

    // 固定操作栏：始终在文档流最底，抽屉面板向上展开，不遮挡此栏。
    const actions = document.createElement('div');
    actions.className = 'ttv2-drawer__actions';
    const slots = document.createElement('div');
    slots.className = 'ttv2-drawer__actions-slot';
    actions.append(slots);

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'ttv2-drawer__handle';
    handle.addEventListener('click', () => {
        setOpen(!state.open);
    });
    actions.append(handle);

    const panel = document.createElement('div');
    panel.className = 'ttv2-drawer__panel';
    const titleEl = document.createElement('div');
    titleEl.className = 'ttv2-drawer__title';
    const body = document.createElement('div');
    body.className = 'ttv2-drawer__body';
    panel.append(titleEl, body);

    el.append(panel, actions);

    function setOpen(open) {
        if (state.open === open) return;
        state = { ...state, open };
        render();
        if (typeof state.onToggle === 'function') state.onToggle(open);
    }

    function render() {
        el.classList.toggle('ttv2-drawer--open', !!state.open);
        panel.setAttribute('aria-hidden', state.open ? 'false' : 'true');
        titleEl.textContent = state.title || '';
        titleEl.style.display = state.title ? '' : 'none';
        handle.textContent = state.open ? '收起' : '展开';
        handle.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    }
    render();

    return {
        el,
        setContent(node) { body.replaceChildren(); if (node) body.append(node); },
        setActions(node) { slots.replaceChildren(); if (node) slots.append(node); },
        update(next = {}) {
            state = { ...state, ...next };
            render();
        },
        destroy() { el.remove(); },
    };
}
