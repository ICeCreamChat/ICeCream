/**
 * timetable-v2 / components / three-pane-layout.js
 *
 * 三栏智能工作台壳（设计决策 5 / spec「Three-Pane Workbench Shell」）：
 *   步骤导航(nav) / 主任务区(main) / 洞察助手(aside)。
 * - 宽屏：三栏并存。
 * - 窄屏（容器宽度 / 媒体查询降级）：洞察助手 → 底部抽屉，步骤导航 → 顶部横条，
 *   主任务区占满；关键操作区固定可达不被抽屉遮挡。
 *
 * 纯 DOM，无 React、无 store、不做任何业务/排课计算。仅提供布局与插槽：
 *   setNav(node) / setMain(node) / setAside(node)。
 *
 * 红线：不 import 任何后端模块；不读写 solution/diagnostics 数据，仅承载子组件。
 *
 * 用法：
 *   const layout = createThreePaneLayout({ narrowBreakpoint: 900 });
 *   document.body.append(layout.el);
 *   layout.setNav(stepNav.el);
 *   layout.setMain(mainEl);
 *   layout.setAside(insightPanel.el);
 *   layout.update({ asideOpen: true });   // 窄屏抽屉开合
 *   layout.destroy();
 */

const STYLE_ID = 'ttv2-three-pane-style';

const STYLE_TEXT = `
.ttv2-shell { display: grid; gap: 12px; width: 100%; box-sizing: border-box;
    grid-template-columns: 220px minmax(0, 1fr) 320px;
    grid-template-areas: "nav main aside"; }
.ttv2-shell__nav { grid-area: nav; min-width: 0; }
.ttv2-shell__main { grid-area: main; min-width: 0; }
.ttv2-shell__aside { grid-area: aside; min-width: 0; }
.ttv2-shell__actions { display: none; }

/* 窄屏降级：单列；nav 顶部横条；aside 底部抽屉；关键操作固定栏 */
.ttv2-shell--narrow { grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "nav" "main"; padding-bottom: 64px; }
.ttv2-shell--narrow .ttv2-shell__nav { overflow-x: auto; white-space: nowrap; }
.ttv2-shell--narrow .ttv2-shell__aside {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
    max-height: 70vh; overflow-y: auto; transform: translateY(100%);
    transition: transform .2s ease; background: var(--ttv2-surface, #fff);
    box-shadow: 0 -8px 24px rgba(0,0,0,.18); border-radius: 12px 12px 0 0; }
.ttv2-shell--narrow.ttv2-shell--aside-open .ttv2-shell__aside { transform: translateY(0); }
.ttv2-shell--narrow .ttv2-shell__actions {
    display: flex; gap: 8px; position: fixed; left: 0; right: 0; bottom: 0;
    z-index: 40; padding: 8px 12px; background: var(--ttv2-surface, #fff);
    box-shadow: 0 -2px 8px rgba(0,0,0,.12); }
`;

/** 按需注入一次样式（仅在浏览器、首次创建组件时触碰 document）。 */
function ensureStyle() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
}

/**
 * 创建三栏布局组件。
 * @param {object} [props]
 * @param {number} [props.narrowBreakpoint=900] 窄屏阈值（px，按容器宽度判断）
 * @param {boolean} [props.asideOpen=false] 窄屏抽屉初始开合
 * @returns {{ el: HTMLElement, update: (next?: object) => void, destroy: () => void,
 *            setNav: (n: Node|null) => void, setMain: (n: Node|null) => void,
 *            setAside: (n: Node|null) => void }}
 */
export function createThreePaneLayout(props = {}) {
    ensureStyle();
    let state = { narrowBreakpoint: 900, asideOpen: false, ...props };

    const el = document.createElement('div');
    el.className = 'ttv2-shell';

    const nav = document.createElement('div');
    nav.className = 'ttv2-shell__nav';
    const main = document.createElement('div');
    main.className = 'ttv2-shell__main';
    const aside = document.createElement('div');
    aside.className = 'ttv2-shell__aside';
    // 窄屏固定操作区：宿主页面把关键操作（生成/确认写入/发布）放进来，避免被抽屉遮挡。
    const actions = document.createElement('div');
    actions.className = 'ttv2-shell__actions';

    el.append(nav, main, aside, actions);

    /** 用 ResizeObserver 按容器宽度切换窄屏（比媒体查询更贴合嵌入式容器）。 */
    let ro = null;
    function applyResponsive(width) {
        const narrow = width > 0 && width < state.narrowBreakpoint;
        el.classList.toggle('ttv2-shell--narrow', narrow);
        el.classList.toggle('ttv2-shell--aside-open', narrow && !!state.asideOpen);
    }
    if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver((entries) => {
            for (const entry of entries) applyResponsive(entry.contentRect.width);
        });
        ro.observe(el);
    }

    function setSlot(host, node) {
        host.replaceChildren();
        if (node) host.append(node);
    }

    return {
        el,
        setNav(node) { setSlot(nav, node); },
        setMain(node) { setSlot(main, node); },
        setAside(node) { setSlot(aside, node); },
        /** 关键操作区（窄屏固定栏）的插槽。 */
        setActions(node) { setSlot(actions, node); },
        update(next = {}) {
            state = { ...state, ...next };
            applyResponsive(el.getBoundingClientRect().width);
        },
        destroy() {
            if (ro) { ro.disconnect(); ro = null; }
            el.remove();
        },
    };
}
