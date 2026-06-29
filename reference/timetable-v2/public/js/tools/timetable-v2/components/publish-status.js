/**
 * timetable-v2 / components / publish-status.js
 *
 * 发布状态提示（spec「Confirmed Writes Go Through Backend Validation」相关交付环节）。
 * 只读展示三态：已发布 / 草稿已改（发布后又有未发布改动）/ 未发布。
 *
 * 纯 DOM。状态由宿主根据后端发布结果与 store 草稿情况推导后传入；
 * 组件本身不判定、不写入、不调用 api。
 *
 * 红线：不 import 后端模块；不做业务计算，仅按传入 status 渲染文案与配色。
 *
 * 用法：
 *   const ps = createPublishStatus({ status: 'unpublished' });
 *   container.append(ps.el);
 *   ps.update({ status: 'dirty', detail: '规则草稿已确认写入，需重新发布' });
 */

const STYLE_ID = 'ttv2-publish-status-style';

const STYLE_TEXT = `
.ttv2-pubstatus { display: inline-flex; align-items: center; gap: 8px;
    padding: 6px 12px; border-radius: 8px; font-size: 14px; font-weight: 600;
    box-sizing: border-box; }
.ttv2-pubstatus__dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.ttv2-pubstatus__detail { font-weight: 400; font-size: 13px; opacity: .85; }
.ttv2-pubstatus--published { background: rgba(16,185,129,.14); color: #047857; }
.ttv2-pubstatus--published .ttv2-pubstatus__dot { background: #059669; }
.ttv2-pubstatus--dirty { background: rgba(217,119,6,.14); color: #b45309; }
.ttv2-pubstatus--dirty .ttv2-pubstatus__dot { background: #d97706; }
.ttv2-pubstatus--unpublished { background: rgba(107,114,128,.14); color: #4b5563; }
.ttv2-pubstatus--unpublished .ttv2-pubstatus__dot { background: #9ca3af; }
`;

function ensureStyle() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
}

// 三态文案（面向用户中文）。未知状态兜底为未发布。
const STATUS_TEXT = {
    published: '已发布',
    dirty: '草稿已改（待重新发布）',
    unpublished: '未发布',
};

function normalizeStatus(status) {
    return STATUS_TEXT[status] ? status : 'unpublished';
}

/**
 * 创建发布状态提示。
 * @param {object} [props]
 * @param {'published'|'dirty'|'unpublished'} [props.status='unpublished'] 发布态
 * @param {string} [props.detail=''] 补充说明
 * @returns {{ el: HTMLElement, update: (next?: object) => void, destroy: () => void }}
 */
export function createPublishStatus(props = {}) {
    ensureStyle();
    let state = { status: 'unpublished', detail: '', ...props };

    const el = document.createElement('div');
    el.className = 'ttv2-pubstatus';
    el.setAttribute('role', 'status');

    const dot = document.createElement('span');
    dot.className = 'ttv2-pubstatus__dot';
    const label = document.createElement('span');
    label.className = 'ttv2-pubstatus__label';
    const detail = document.createElement('span');
    detail.className = 'ttv2-pubstatus__detail';

    el.append(dot, label, detail);

    function render() {
        const status = normalizeStatus(state.status);
        el.classList.remove(
            'ttv2-pubstatus--published',
            'ttv2-pubstatus--dirty',
            'ttv2-pubstatus--unpublished',
        );
        el.classList.add(`ttv2-pubstatus--${status}`);
        label.textContent = STATUS_TEXT[status];
        detail.textContent = state.detail || '';
        detail.style.display = state.detail ? '' : 'none';
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
