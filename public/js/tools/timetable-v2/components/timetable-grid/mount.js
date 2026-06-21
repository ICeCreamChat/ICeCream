/**
 * timetable-v2 / components / timetable-grid / mount.js
 *
 * vanilla ↔ React 的桥（设计决策 1）。单向：props 进，事件回调出。
 * vanilla 工作台页面把一个 DOM 节点交给这里，由 react-dom 把课表网格挂上去。
 *
 * 用法（vanilla 侧）：
 *   import { mountGrid, updateGrid, unmountGrid } from './components/timetable-grid/mount.js';
 *   const handle = mountGrid(el, { project, solution, conflictCells, onCellClick });
 *   handle.update({ solution: newSolution });   // 或 updateGrid(el, {...})
 *   handle.unmount();                            // 或 unmountGrid(el)
 *
 * 红线：网格只读 props 渲染，不修改数据、不写 store、不算冲突 / 候选位。
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import TimetableGrid from './grid.jsx';

// 每个 DOM 节点对应一个 React root + 最新 props，支持 update / unmount。
const registry = new WeakMap();

/**
 * 把课表网格挂到给定 DOM 节点。
 * @param {HTMLElement} domEl 容器节点
 * @param {object}      props TimetableGrid 的 props（project / solution / conflictCells / onCellClick）
 * @returns {{ update: (next?: object) => void, unmount: () => void }}
 */
export function mountGrid(domEl, props = {}) {
    if (!domEl) {
        return { update() {}, unmount() {} };
    }
    // 同一节点重复 mount：复用已有 root，等价于一次 update。
    const existing = registry.get(domEl);
    if (existing) {
        existing.props = { ...props };
        existing.render();
        return existing.handle;
    }

    const root = createRoot(domEl);
    const entry = {
        root,
        props: { ...props },
        render() {
            root.render(React.createElement(TimetableGrid, { ...entry.props }));
        },
        handle: null,
    };
    entry.handle = {
        update(next = {}) {
            entry.props = { ...entry.props, ...next };
            entry.render();
        },
        unmount() {
            root.unmount();
            registry.delete(domEl);
        },
    };
    registry.set(domEl, entry);
    entry.render();
    return entry.handle;
}

/**
 * 更新已挂载网格的 props（浅合并）。节点未挂载时按首挂处理。
 * @param {HTMLElement} domEl
 * @param {object}      next
 */
export function updateGrid(domEl, next = {}) {
    const entry = domEl && registry.get(domEl);
    if (!entry) return mountGrid(domEl, next);
    entry.handle.update(next);
    return entry.handle;
}

/**
 * 卸载指定节点上的网格。
 * @param {HTMLElement} domEl
 */
export function unmountGrid(domEl) {
    const entry = domEl && registry.get(domEl);
    if (entry) entry.handle.unmount();
}

// 与 studio 画布一致：暴露到 window 便于 vanilla 直接取用（可选）。
if (typeof window !== 'undefined') {
    window.TimetableGrid = { mountGrid, updateGrid, unmountGrid };
}
