/**
 * timetable-v2 / views / result-diagnostics.js
 *
 * 交互主线第 5 步「结果诊断」。挂 timetable-grid（mountGrid，传 project/solution）
 * + 质量问题 / 未排原因（只读 diagnostics）。
 *
 * React 网格的挂载 / 卸载在 mount() / destroy() 里管：
 *   - mount()：把网格挂到本页的 DOM 容器；
 *   - destroy()：unmountGrid 释放 React root，避免泄漏 / 重复挂载。
 *
 * ───────────────────────── 红线 ─────────────────────────
 * - 不 import 后端模块；不在前端算冲突 / 候选 / 未排原因。
 * - conflictCells 由 solution.hardConflicts 派生（只读后端给的坐标，不做判定）。
 *
 * 导出 createResultDiagnosticsView({ store, api }) → { el, mount(), update(), destroy() }
 */

import { mountGrid, updateGrid, unmountGrid } from '../components/timetable-grid/mount.js';
import { createConflictGroup } from '../components/conflict-group.js';

const STYLE_ID = 'ttv2-view-result-diag-style';

const STYLE_TEXT = `
.ttv2-result__grid-wrap { overflow: auto; border: 1px solid var(--ttv2-border, #e5e7eb);
    border-radius: 10px; background: var(--ttv2-surface, #fff); padding: 8px; }
.ttv2-result__scores { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.ttv2-result__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ttv2-result__unplaced { padding: 8px 10px; border-radius: 8px; line-height: 1.4;
    background: rgba(217,119,6,.08); border-left: 3px solid #d97706; }
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
 * 从后端 solution.hardConflicts 取冲突格坐标（只读，不做任何判定）。
 * 兼容 hardConflicts 项形如 { day, period } 或 { cell: {day, period} }。
 */
function conflictCellsFromSolution(solution) {
    const list = (solution && Array.isArray(solution.hardConflicts)) ? solution.hardConflicts : [];
    const cells = [];
    for (const c of list) {
        const cell = c && c.cell ? c.cell : c;
        if (cell && cell.day != null && cell.period != null) {
            cells.push({ day: cell.day, period: cell.period });
        }
    }
    return cells;
}

/**
 * 创建结果诊断页。
 * @param {object} deps
 * @param {object} deps.store store（读 project / solution / diagnostics）
 * @param {object} deps.api   未在本页写入，仅对齐签名
 */
export function createResultDiagnosticsView({ store, api }) {
    ensureStyle();

    const el = document.createElement('section');
    el.className = 'ttv2-view ttv2-view--result-diagnostics';

    const title = document.createElement('h1');
    title.className = 'ttv2-view__title';
    title.textContent = '结果诊断';
    const hint = document.createElement('p');
    hint.className = 'ttv2-view__hint';
    hint.textContent = '网格只读后端 solution 渲染，冲突 / 未排原因来自 solution 与 diagnostics。';

    // 质量分数卡片
    const scoreCard = document.createElement('div');
    scoreCard.className = 'ttv2-view__card';
    const scoreTitle = document.createElement('h2');
    scoreTitle.className = 'ttv2-view__card-title';
    scoreTitle.textContent = '质量概览';
    const scores = document.createElement('div');
    scores.className = 'ttv2-result__scores';
    scoreCard.append(scoreTitle, scores);

    // 课表网格卡片
    const gridCard = document.createElement('div');
    gridCard.className = 'ttv2-view__card';
    const gridTitle = document.createElement('h2');
    gridTitle.className = 'ttv2-view__card-title';
    gridTitle.textContent = '课表网格';
    const gridWrap = document.createElement('div');
    gridWrap.className = 'ttv2-result__grid-wrap';
    const gridRoot = document.createElement('div');   // React 网格挂载点
    gridWrap.append(gridRoot);
    gridCard.append(gridTitle, gridWrap);

    // 冲突分组（只读 diagnostics）
    const conflictCard = document.createElement('div');
    conflictCard.className = 'ttv2-view__card';
    const conflictTitle = document.createElement('h2');
    conflictTitle.className = 'ttv2-view__card-title';
    conflictTitle.textContent = '质量问题与硬冲突';
    const conflictGroup = createConflictGroup({ diagnostics: store.getState().diagnostics, groupBy: 'object' });
    conflictCard.append(conflictTitle, conflictGroup.el);

    // 未排原因卡片
    const unplacedCard = document.createElement('div');
    unplacedCard.className = 'ttv2-view__card';
    const unplacedTitle = document.createElement('h2');
    unplacedTitle.className = 'ttv2-view__card-title';
    unplacedTitle.textContent = '未排原因';
    const unplacedList = document.createElement('ul');
    unplacedList.className = 'ttv2-result__list';
    unplacedCard.append(unplacedTitle, unplacedList);

    el.append(title, hint, scoreCard, gridCard, conflictCard, unplacedCard);

    let gridMounted = false;

    function scoreBox(num, label) {
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

    function renderScores() {
        const s = store.getState().solution || {};
        const stats = s.stats || {};
        scores.replaceChildren();
        if (s.softScore != null) scores.append(scoreBox(s.softScore, '软分数'));
        if (stats.placed != null) scores.append(scoreBox(stats.placed, '已排课节'));
        scores.append(scoreBox((s.unplaced || []).length, '未排课节'));
        scores.append(scoreBox((s.hardConflicts || []).length, '硬冲突'));
        if (!scores.children.length) {
            const empty = document.createElement('div');
            empty.className = 'ttv2-view__empty';
            empty.textContent = '暂无求解结果，请先在「求解进度」页生成。';
            scores.append(empty);
        }
    }

    function renderUnplaced() {
        const s = store.getState().solution || {};
        const unplaced = Array.isArray(s.unplaced) ? s.unplaced : [];
        unplacedList.replaceChildren();
        if (!unplaced.length) {
            const empty = document.createElement('li');
            empty.className = 'ttv2-view__empty';
            empty.textContent = '没有未排课节。';
            unplacedList.append(empty);
            return;
        }
        for (const u of unplaced) {
            const li = document.createElement('li');
            li.className = 'ttv2-result__unplaced';
            // 只读后端给的未排描述 / 原因，不在前端推导。
            li.textContent = u.reason || u.message || u.activityId || JSON.stringify(u);
            unplacedList.append(li);
        }
    }

    function renderGrid() {
        const state = store.getState();
        const props = {
            project: state.project,
            solution: state.solution,
            conflictCells: conflictCellsFromSolution(state.solution),
            onCellClick: null,   // 结果诊断页只读，不处理点击意图
        };
        if (!gridMounted) {
            mountGrid(gridRoot, props);
            gridMounted = true;
        } else {
            updateGrid(gridRoot, props);
        }
    }

    function renderAll() {
        renderScores();
        renderUnplaced();
        conflictGroup.update({ diagnostics: store.getState().diagnostics });
        renderGrid();
    }

    let unsub = null;

    return {
        el,
        mount() {
            unsub = store.subscribe(renderAll);
            renderScores();
            renderUnplaced();
            conflictGroup.update({ diagnostics: store.getState().diagnostics });
            renderGrid();   // 首次挂载 React 网格
        },
        update() { renderAll(); },
        destroy() {
            if (unsub) { unsub(); unsub = null; }
            // 释放 React root，避免泄漏 / 切走再回来时重复挂载。
            if (gridMounted) { unmountGrid(gridRoot); gridMounted = false; }
            conflictGroup.destroy();
            el.remove();
        },
    };
}
