/**
 * timetable-v2 / views / rule-review.js
 *
 * 交互主线第 3 步「规则审核」。列出：
 *   - pendingRules（用 createRuleCard 渲染草稿，applied:false）
 *   - 已写入规则（project.constraints，用 createRuleCard 渲染为已写入）
 *   - 冲突 / 未排（createConflictGroup，只读 diagnostics）
 *   - 修复建议（diagnostics.suggestions，标注草稿）
 * 「确认写入」调 api.commitRules → 成功后 setProject 替换引用、clearPendingRules。
 *
 * ───────────────────────── 红线 ─────────────────────────
 * - 不 import 后端模块；不在前端拼业务对象、不做冲突 / 可行性计算。
 * - 写入只经 api.commitRules（唯一写入口）→ 后端 normalize+validate。
 *
 * 导出 createRuleReviewView({ store, api }) → { el, mount(), update(), destroy() }
 */

import { createRuleCard } from '../components/rule-card.js';
import { createConflictGroup } from '../components/conflict-group.js';

const STYLE_ID = 'ttv2-view-rule-review-style';

const STYLE_TEXT = `
.ttv2-rreview__cards { display: flex; flex-direction: column; gap: 8px; }
.ttv2-rreview__sug { padding: 8px 10px; border-radius: 8px; line-height: 1.4;
    border: 1px dashed var(--ttv2-draft-border, #a78bfa); background: var(--ttv2-draft-bg, #f5f3ff); }
.ttv2-rreview__sug-tag { display: inline-block; margin-right: 6px; padding: 1px 6px;
    border-radius: 4px; font-size: 11px; font-weight: 600;
    background: var(--ttv2-draft-border, #a78bfa); color: #fff; }
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
 * 创建规则审核页。
 * @param {object} deps
 * @param {object} deps.store store（读 pendingRules / project / diagnostics）
 * @param {object} deps.api   api（commitRules → 唯一写入口）
 */
export function createRuleReviewView({ store, api }) {
    ensureStyle();

    const el = document.createElement('section');
    el.className = 'ttv2-view ttv2-view--rule-review';

    const title = document.createElement('h1');
    title.className = 'ttv2-view__title';
    title.textContent = '规则审核';
    const hint = document.createElement('p');
    hint.className = 'ttv2-view__hint';
    hint.textContent = '草稿与已写入规则视觉区分。确认写入经后端 normalize+validate，前端不本地落库。';

    // 待确认草稿卡片
    const draftCard = document.createElement('div');
    draftCard.className = 'ttv2-view__card';
    const draftTitle = document.createElement('h2');
    draftTitle.className = 'ttv2-view__card-title';
    draftTitle.textContent = '待确认草稿';
    const draftCards = document.createElement('div');
    draftCards.className = 'ttv2-rreview__cards';
    const draftActions = document.createElement('div');
    draftActions.className = 'ttv2-view__row';
    const commitBtn = document.createElement('button');
    commitBtn.type = 'button';
    commitBtn.className = 'ttv2-view__btn';
    commitBtn.textContent = '确认写入全部草稿';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'ttv2-view__btn ttv2-view__btn--ghost';
    clearBtn.textContent = '清空草稿';
    draftActions.append(commitBtn, clearBtn);
    const msg = document.createElement('div');
    msg.className = 'ttv2-view__msg';
    draftCard.append(draftTitle, draftCards, draftActions, msg);

    // 已写入规则卡片
    const appliedCard = document.createElement('div');
    appliedCard.className = 'ttv2-view__card';
    const appliedTitle = document.createElement('h2');
    appliedTitle.className = 'ttv2-view__card-title';
    appliedTitle.textContent = '已写入规则';
    const appliedCards = document.createElement('div');
    appliedCards.className = 'ttv2-rreview__cards';
    appliedCard.append(appliedTitle, appliedCards);

    // 冲突 / 未排（只读 diagnostics）
    const conflictCard = document.createElement('div');
    conflictCard.className = 'ttv2-view__card';
    const conflictTitle = document.createElement('h2');
    conflictTitle.className = 'ttv2-view__card-title';
    conflictTitle.textContent = '冲突与未排';
    const conflictGroup = createConflictGroup({ diagnostics: store.getState().diagnostics, groupBy: 'object' });
    conflictCard.append(conflictTitle, conflictGroup.el);

    // 修复建议
    const sugCard = document.createElement('div');
    sugCard.className = 'ttv2-view__card';
    const sugTitle = document.createElement('h2');
    sugTitle.className = 'ttv2-view__card-title';
    sugTitle.textContent = '修复建议';
    const sugList = document.createElement('div');
    sugList.className = 'ttv2-rreview__cards';
    sugCard.append(sugTitle, sugList);

    el.append(title, hint, draftCard, appliedCard, conflictCard, sugCard);

    // 子卡片实例管理（每次重渲染销毁旧实例，避免泄漏）。
    let draftCardInstances = [];
    let appliedCardInstances = [];

    function destroyCards(arr) {
        for (const c of arr) c.destroy();
        return [];
    }

    function setMsg(text, kind) {
        msg.textContent = text || '';
        msg.classList.toggle('ttv2-view__msg--ok', kind === 'ok');
        msg.classList.toggle('ttv2-view__msg--err', kind === 'err');
    }

    function renderDrafts() {
        draftCardInstances = destroyCards(draftCardInstances);
        draftCards.replaceChildren();
        const drafts = store.getState().pendingRules || [];
        commitBtn.disabled = drafts.length === 0;
        clearBtn.disabled = drafts.length === 0;
        if (!drafts.length) {
            const empty = document.createElement('div');
            empty.className = 'ttv2-view__empty';
            empty.textContent = '暂无待确认草稿，去「规则输入」生成。';
            draftCards.append(empty);
            return;
        }
        for (const rule of drafts) {
            // onConfirm 经 api 写入口（confirmAll 已覆盖全量；单条同样走 commit）。
            const card = createRuleCard({ rule, onConfirm: () => commitAll() });
            draftCardInstances.push(card);
            draftCards.append(card.el);
        }
    }

    function renderApplied() {
        appliedCardInstances = destroyCards(appliedCardInstances);
        appliedCards.replaceChildren();
        const p = store.getState().project;
        const constraints = (p && Array.isArray(p.constraints)) ? p.constraints : [];
        if (!constraints.length) {
            const empty = document.createElement('div');
            empty.className = 'ttv2-view__empty';
            empty.textContent = '项目暂无已写入规则。';
            appliedCards.append(empty);
            return;
        }
        for (const c of constraints) {
            // 已写入项标记 applied:true（不携带 onConfirm，渲染为已写入态）。
            const card = createRuleCard({ rule: { ...c, applied: true } });
            appliedCardInstances.push(card);
            appliedCards.append(card.el);
        }
    }

    function renderSuggestions() {
        const d = store.getState().diagnostics || {};
        const suggestions = Array.isArray(d.suggestions) ? d.suggestions : [];
        sugList.replaceChildren();
        if (!suggestions.length) {
            const empty = document.createElement('div');
            empty.className = 'ttv2-view__empty';
            empty.textContent = '暂无修复建议。';
            sugList.append(empty);
            return;
        }
        for (const sug of suggestions) {
            const box = document.createElement('div');
            box.className = 'ttv2-rreview__sug';
            const tag = document.createElement('span');
            tag.className = 'ttv2-rreview__sug-tag';
            tag.textContent = '建议草稿';
            const text = document.createElement('span');
            text.textContent = sug.message || sug.expectedRelief || '';
            box.append(tag, text);
            sugList.append(box);
        }
    }

    function renderAll() {
        renderDrafts();
        renderApplied();
        renderSuggestions();
        conflictGroup.update({ diagnostics: store.getState().diagnostics });
    }

    // 确认写入：把全部草稿原始输入交后端 normalize+validate（唯一写入口）。
    async function commitAll() {
        const drafts = store.getState().pendingRules || [];
        if (!drafts.length) return;
        commitBtn.disabled = true;
        setMsg('正在写入规则…', null);
        try {
            // 一次提交全部草稿原始输入，由后端拼装 + 校验，返回新 project 引用。
            const project = await api.commitRules({ kind: 'rules-batch', drafts });
            store.dispatch('setProject', project);   // 用后端结果替换引用
            store.dispatch('clearPendingRules');      // 清理已确认草稿
            setMsg('规则已写入项目。', 'ok');
        } catch (err) {
            setMsg(err.message || '写入失败', 'err');
        } finally {
            commitBtn.disabled = (store.getState().pendingRules || []).length === 0;
        }
    }

    commitBtn.addEventListener('click', commitAll);
    clearBtn.addEventListener('click', () => store.dispatch('clearPendingRules'));

    let unsub = null;

    return {
        el,
        mount() {
            unsub = store.subscribe(renderAll);
            renderAll();
        },
        update() { renderAll(); },
        destroy() {
            if (unsub) { unsub(); unsub = null; }
            draftCardInstances = destroyCards(draftCardInstances);
            appliedCardInstances = destroyCards(appliedCardInstances);
            conflictGroup.destroy();
            el.remove();
        },
    };
}
