/**
 * timetable-v2 / views / publish-export.js
 *
 * 交互主线第 7 步「发布导出」。createPublishStatus 展示发布态 + 发布按钮
 * （api.publish 前过后端校验）+ 导出入口 + 历史列表。
 *
 * ───────────────────────── 红线 ─────────────────────────
 * - 不 import 后端模块；不在前端做发布前校验 / 冲突判定，校验在后端。
 * - 发布只经 api.publish（唯一写入口）→ 后端发布前 validate。
 * - 发布态由后端结果 + store 草稿情况推导后传入组件，组件本身不判定。
 *
 * 导出 createPublishExportView({ store, api }) → { el, mount(), update(), destroy() }
 */

import { createPublishStatus } from '../components/publish-status.js';

const STYLE_ID = 'ttv2-view-publish-export-style';

const STYLE_TEXT = `
.ttv2-publish__history { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ttv2-publish__history-item { display: flex; gap: 8px; align-items: baseline;
    padding: 8px 10px; border-radius: 8px; background: var(--ttv2-surface-alt, #f9fafb); }
.ttv2-publish__history-time { font-size: 12px; color: var(--ttv2-text-muted, #6b7280); }
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
 * 创建发布导出页。
 * @param {object} deps
 * @param {object} deps.store store（读 solution / pendingRules，写发布结果 solution 引用）
 * @param {object} deps.api   api（publish → 唯一写入口）
 */
export function createPublishExportView({ store, api }) {
    ensureStyle();

    const el = document.createElement('section');
    el.className = 'ttv2-view ttv2-view--publish-export';

    const title = document.createElement('h1');
    title.className = 'ttv2-view__title';
    title.textContent = '发布导出';
    const hint = document.createElement('p');
    hint.className = 'ttv2-view__hint';
    hint.textContent = '发布经后端发布前校验（硬冲突 / 未排会被拦截）。前端不在本地判定可否发布。';

    // 发布状态卡片
    const statusCard = document.createElement('div');
    statusCard.className = 'ttv2-view__card';
    const statusTitle = document.createElement('h2');
    statusTitle.className = 'ttv2-view__card-title';
    statusTitle.textContent = '发布状态';
    const publishStatus = createPublishStatus({ status: 'unpublished' });
    const actionRow = document.createElement('div');
    actionRow.className = 'ttv2-view__row';
    const publishBtn = document.createElement('button');
    publishBtn.type = 'button';
    publishBtn.className = 'ttv2-view__btn';
    publishBtn.textContent = '发布课表';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'ttv2-view__btn ttv2-view__btn--ghost';
    exportBtn.textContent = '导出课表';
    actionRow.append(publishBtn, exportBtn);
    const msg = document.createElement('div');
    msg.className = 'ttv2-view__msg';
    statusCard.append(statusTitle, publishStatus.el, actionRow, msg);

    // 发布历史卡片（只读后端返回的历史，若无则空）。
    const historyCard = document.createElement('div');
    historyCard.className = 'ttv2-view__card';
    const historyTitle = document.createElement('h2');
    historyTitle.className = 'ttv2-view__card-title';
    historyTitle.textContent = '发布历史';
    const historyList = document.createElement('ul');
    historyList.className = 'ttv2-publish__history';
    historyCard.append(historyTitle, historyList);

    el.append(title, hint, statusCard, historyCard);

    // 本地仅记录发布动作的可读历史（UI 态，非业务对象 / 非派生排课结果）。
    let history = [];
    // 是否已发布过（用于推导 published / dirty / unpublished 三态）。
    let published = false;

    function setMsg(text, kind) {
        msg.textContent = text || '';
        msg.classList.toggle('ttv2-view__msg--ok', kind === 'ok');
        msg.classList.toggle('ttv2-view__msg--err', kind === 'err');
    }

    // 推导发布态：未发布 / 已发布 / 已发布但有未写入草稿（dirty）。
    function renderStatus() {
        const drafts = (store.getState().pendingRules || []).length;
        if (!published) {
            publishStatus.update({ status: 'unpublished', detail: '尚未发布' });
        } else if (drafts > 0) {
            publishStatus.update({ status: 'dirty', detail: `有 ${drafts} 条草稿待确认写入，需重新发布` });
        } else {
            publishStatus.update({ status: 'published', detail: '当前课表已发布' });
        }
    }

    function renderHistory() {
        historyList.replaceChildren();
        if (!history.length) {
            const empty = document.createElement('li');
            empty.className = 'ttv2-view__empty';
            empty.textContent = '暂无发布记录。';
            historyList.append(empty);
            return;
        }
        for (const h of history) {
            const li = document.createElement('li');
            li.className = 'ttv2-publish__history-item';
            const time = document.createElement('span');
            time.className = 'ttv2-publish__history-time';
            time.textContent = h.time;
            const text = document.createElement('span');
            text.textContent = h.label;
            li.append(time, text);
            historyList.append(li);
        }
    }

    function renderAll() {
        renderStatus();
        renderHistory();
    }

    // 发布：经 api.publish（唯一写入口）→ 后端发布前校验。成功后回写 solution 引用。
    async function doPublish() {
        publishBtn.disabled = true;
        setMsg('正在请求后端发布校验…', null);
        try {
            const result = await api.publish({});
            // 后端返回发布结果（含校验通过后的 solution）；用其替换 store 引用。
            if (result && result.solution) {
                store.dispatch('setSolution', result.solution);
            }
            published = true;
            history = [{ time: new Date().toLocaleString(), label: '课表已发布' }, ...history];
            renderAll();
            setMsg('发布成功，课表已通过后端发布前校验。', 'ok');
        } catch (err) {
            // 发布被后端拦截（硬冲突 / 未排等），错误文案已由 api 层映射为中文。
            setMsg(err.message || '发布失败', 'err');
        } finally {
            publishBtn.disabled = false;
        }
    }

    // 导出：导出入口同样以后端为准（mock 下仅提示）。前端不在本地生成最终课表数据。
    function doExport() {
        const solution = store.getState().solution;
        if (!solution) {
            setMsg('暂无可导出的课表，请先求解并发布。', 'err');
            return;
        }
        setMsg('导出入口已触发（实际导出由后端生成文件）。', 'ok');
    }

    publishBtn.addEventListener('click', doPublish);
    exportBtn.addEventListener('click', doExport);

    let unsub = null;

    return {
        el,
        mount() {
            unsub = store.subscribe(renderStatus);
            renderAll();
        },
        update() { renderAll(); },
        destroy() {
            if (unsub) { unsub(); unsub = null; }
            publishStatus.destroy();
            el.remove();
        },
    };
}
