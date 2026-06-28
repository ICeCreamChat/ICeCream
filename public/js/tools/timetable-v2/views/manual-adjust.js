/**
 * timetable-v2 / views / manual-adjust.js
 *
 * 交互主线第 6 步「手动调整」。网格上 onCellClick 发起调整意图 →
 * api.commitAdjustment（走后端校验）→ 成功后 setSolution 回写引用。
 * **不在前端改 solution**，前端只采集「点了哪个格 / 想移动到哪」的原始意图。
 *
 * ───────────────────────── 红线 ─────────────────────────
 * - 不 import 后端模块；不在前端算冲突 / 候选位 / 可行性，不本地改 solution。
 * - 调整经 api.commitAdjustment（唯一写入口）→ 后端 normalize+validate。
 *
 * 导出 createManualAdjustView({ store, api }) → { el, mount(), update(), destroy() }
 */

import { mountGrid, updateGrid, unmountGrid } from '../components/timetable-grid/mount.js';

const STYLE_ID = 'ttv2-view-manual-adjust-style';

const STYLE_TEXT = `
.ttv2-adjust__grid-wrap { overflow: auto; border: 1px solid var(--ttv2-border, #e5e7eb);
    border-radius: 10px; background: var(--ttv2-surface, #fff); padding: 8px; }
.ttv2-adjust__sel { font-size: 13px; color: var(--ttv2-text-muted, #6b7280); min-height: 18px; }
.ttv2-adjust__pending { padding: 8px 10px; border-radius: 8px; line-height: 1.4;
    border: 1px dashed var(--ttv2-draft-border, #a78bfa); background: var(--ttv2-draft-bg, #f5f3ff); }
`;

function ensureStyle() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
}

function cellLabel(cell) {
    if (!cell) return '（无）';
    const base = `周${cell.day} 第${cell.period}节`;
    if (cell.placement && cell.placement.subjectId) return `${base}（${cell.placement.subjectId}）`;
    return `${base}（空）`;
}

/**
 * 创建手动调整页。
 * @param {object} deps
 * @param {object} deps.store store（读 project / solution，写 solution 引用）
 * @param {object} deps.api   api（commitAdjustment → 唯一写入口）
 */
export function createManualAdjustView({ store, api }) {
    ensureStyle();

    const el = document.createElement('section');
    el.className = 'ttv2-view ttv2-view--manual-adjust';

    const title = document.createElement('h1');
    title.className = 'ttv2-view__title';
    title.textContent = '手动调整';
    const hint = document.createElement('p');
    hint.className = 'ttv2-view__hint';
    hint.textContent = '点选源格与目标格发起移动意图，调整经后端校验。前端不本地改课表、不算可行性。';

    const card = document.createElement('div');
    card.className = 'ttv2-view__card';

    const selInfo = document.createElement('div');
    selInfo.className = 'ttv2-adjust__sel';

    const gridWrap = document.createElement('div');
    gridWrap.className = 'ttv2-adjust__grid-wrap';
    const gridRoot = document.createElement('div');
    gridWrap.append(gridRoot);

    const actionRow = document.createElement('div');
    actionRow.className = 'ttv2-view__row';
    const moveBtn = document.createElement('button');
    moveBtn.type = 'button';
    moveBtn.className = 'ttv2-view__btn';
    moveBtn.textContent = '提交移动';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'ttv2-view__btn ttv2-view__btn--ghost';
    clearBtn.textContent = '清除选择';
    actionRow.append(moveBtn, clearBtn);

    const msg = document.createElement('div');
    msg.className = 'ttv2-view__msg';

    card.append(selInfo, gridWrap, actionRow, msg);
    el.append(title, hint, card);

    let gridMounted = false;
    // 本地仅保存「选择意图」（点了哪两个格），不是 solution 派生状态。
    let source = null;   // 第一个点击的格（含 placement 原始引用）
    let target = null;   // 第二个点击的格

    function setMsg(text, kind) {
        msg.textContent = text || '';
        msg.classList.toggle('ttv2-view__msg--ok', kind === 'ok');
        msg.classList.toggle('ttv2-view__msg--err', kind === 'err');
    }

    function renderSel() {
        selInfo.textContent = `源：${cellLabel(source)} → 目标：${cellLabel(target)}`;
        moveBtn.disabled = !(source && target);
    }

    function onCellClick(cell) {
        // 仅记录点击意图：第一击为源，第二击为目标；再点重置为新源。
        if (!source || (source && target)) {
            source = cell;
            target = null;
        } else {
            target = cell;
        }
        renderSel();
    }

    function renderGrid() {
        const state = store.getState();
        const props = {
            project: state.project,
            solution: state.solution,
            conflictCells: [],
            onCellClick,
        };
        if (!gridMounted) {
            mountGrid(gridRoot, props);
            gridMounted = true;
        } else {
            updateGrid(gridRoot, props);
        }
    }

    // 提交调整：把原始意图交后端校验；成功用后端返回 solution 替换引用。
    async function submitMove() {
        if (!(source && target)) return;
        moveBtn.disabled = true;
        setMsg('正在提交调整…', null);
        try {
            const payload = {
                type: 'move',
                from: { day: source.day, period: source.period },
                to: { day: target.day, period: target.period },
                activityId: source.placement ? source.placement.activityId : null,
            };
            const result = await api.commitAdjustment({ project: store.getState().project, adjustment: payload });
            store.dispatch('setSolution', result.solution || result);   // 后端结果回写引用
            source = null; target = null;
            renderSel();
            setMsg('调整已提交并通过后端校验。', 'ok');
        } catch (err) {
            setMsg(err.message || '调整失败', 'err');
        } finally {
            moveBtn.disabled = !(source && target);
        }
    }

    moveBtn.addEventListener('click', submitMove);
    clearBtn.addEventListener('click', () => { source = null; target = null; renderSel(); });

    let unsub = null;

    return {
        el,
        mount() {
            unsub = store.subscribe(renderGrid);
            renderSel();
            renderGrid();
        },
        update() { renderGrid(); },
        destroy() {
            if (unsub) { unsub(); unsub = null; }
            if (gridMounted) { unmountGrid(gridRoot); gridMounted = false; }
            el.remove();
        },
    };
}
