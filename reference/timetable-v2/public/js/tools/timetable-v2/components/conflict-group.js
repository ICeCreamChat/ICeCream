/**
 * timetable-v2 / components / conflict-group.js
 *
 * 冲突分组展示（spec「Frontend Carries No Scheduling Logic」/「网格只读后端解」）。
 * 把 diagnostics.items 中 category 为 hard-conflict / unplaced 的项，按对象（班级/教师/科目/教室）
 * 或类型分组展示，只读 item.message。
 *
 * 红线（强制）：
 *   - 不 import 任何后端模块。
 *   - 不在前端做冲突判定 / 候选位计算，仅按已有字段分组并读 message。
 *
 * 用法：
 *   const group = createConflictGroup({ diagnostics: store.getState().diagnostics, groupBy: 'object' });
 *   container.append(group.el);
 *   store.subscribe((s) => group.update({ diagnostics: s.diagnostics }));
 */

const STYLE_ID = 'ttv2-conflict-group-style';

const STYLE_TEXT = `
.ttv2-conflict { display: flex; flex-direction: column; gap: 10px;
    font-size: 14px; color: var(--ttv2-text, #1f2937); }
.ttv2-conflict__group { border: 1px solid var(--ttv2-border, #e5e7eb); border-radius: 10px; overflow: hidden; }
.ttv2-conflict__group-head { display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; background: rgba(220,38,38,.08); font-weight: 600; }
.ttv2-conflict__count { margin-left: auto; font-size: 12px; font-weight: 600;
    padding: 1px 8px; border-radius: 999px; background: rgba(220,38,38,.18); color: #b91c1c; }
.ttv2-conflict__list { list-style: none; margin: 0; padding: 0; }
.ttv2-conflict__item { padding: 8px 12px; border-top: 1px solid var(--ttv2-border, #f1f1f1); line-height: 1.4; }
.ttv2-conflict__item-cat { font-size: 12px; color: var(--ttv2-text-muted, #6b7280); margin-right: 6px; }
.ttv2-conflict__empty { color: var(--ttv2-text-muted, #9ca3af); font-size: 13px; padding: 8px 0; }
`;

function ensureStyle() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
}

// 需要展示的冲突 / 未排类别。
const CONFLICT_CATEGORIES = ['hard-conflict', 'unplaced'];

const CATEGORY_LABEL = {
    'hard-conflict': '硬冲突',
    'unplaced': '未排课节',
};

/**
 * 从一条诊断项里取一个分组 key（按对象优先，回退到类别）。
 * 仅读取已有 objects 字段，不做任何推导计算。
 */
function groupKeyOf(item, groupBy) {
    if (groupBy === 'type') return item.category || '其他';
    const obj = item.objects || {};
    const pick = (v) => (Array.isArray(v) ? v[0] : v);
    const key = pick(obj.classes) || pick(obj.teachers) || pick(obj.subject || obj.subjects) || pick(obj.rooms);
    return key || CATEGORY_LABEL[item.category] || '未关联对象';
}

/**
 * 创建冲突分组组件。
 * @param {object} [props]
 * @param {object|null} [props.diagnostics] 后端 diagnostics（读 items）
 * @param {'object'|'type'} [props.groupBy='object'] 分组维度
 * @returns {{ el: HTMLElement, update: (next?: object) => void, destroy: () => void }}
 */
export function createConflictGroup(props = {}) {
    ensureStyle();
    let state = { diagnostics: null, groupBy: 'object', ...props };

    const el = document.createElement('section');
    el.className = 'ttv2-conflict';
    el.setAttribute('aria-label', '冲突与未排分组');

    function collectItems() {
        const d = state.diagnostics || {};
        const items = Array.isArray(d.items) ? d.items : [];
        // 只筛选 hard-conflict / unplaced，不重新判定任何冲突。
        return items.filter((it) => CONFLICT_CATEGORIES.includes(it.category));
    }

    function render() {
        el.replaceChildren();
        const items = collectItems();
        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'ttv2-conflict__empty';
            empty.textContent = '无硬冲突或未排课节';
            el.append(empty);
            return;
        }

        // 分组（保持出现顺序）。
        const groups = new Map();
        for (const it of items) {
            const key = groupKeyOf(it, state.groupBy);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(it);
        }

        for (const [key, groupItems] of groups) {
            const groupEl = document.createElement('div');
            groupEl.className = 'ttv2-conflict__group';

            const head = document.createElement('div');
            head.className = 'ttv2-conflict__group-head';
            const titleEl = document.createElement('span');
            titleEl.textContent = key;
            const count = document.createElement('span');
            count.className = 'ttv2-conflict__count';
            count.textContent = String(groupItems.length);
            head.append(titleEl, count);

            const list = document.createElement('ul');
            list.className = 'ttv2-conflict__list';
            for (const it of groupItems) {
                const li = document.createElement('li');
                li.className = 'ttv2-conflict__item';
                const cat = document.createElement('span');
                cat.className = 'ttv2-conflict__item-cat';
                cat.textContent = CATEGORY_LABEL[it.category] || it.category || '';
                const msg = document.createElement('span');
                // 只读后端 message。
                msg.textContent = it.message || '';
                li.append(cat, msg);
                list.append(li);
            }

            groupEl.append(head, list);
            el.append(groupEl);
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
