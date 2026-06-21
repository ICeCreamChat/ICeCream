/**
 * timetable-v2 / views / solve-progress.js
 *
 * 交互主线第 4 步「求解进度」。触发 api.solve，展示 solverJob 进度 / 分数，
 * 完成后 setSolution / setDiagnostics（用后端返回引用，前端不算解）。
 *
 * ───────────────────────── 红线 ─────────────────────────
 * - 不 import 后端模块；不在前端做任何求解 / 评分 / 冲突计算。
 * - solution / diagnostics 一律来自后端返回，store 只存引用。
 *
 * 导出 createSolveProgressView({ store, api }) → { el, mount(), update(), destroy() }
 */

const STYLE_ID = 'ttv2-view-solve-progress-style';

const STYLE_TEXT = `
.ttv2-solve__bar { height: 12px; border-radius: 999px; background: var(--ttv2-surface-alt, #f1f5f9); overflow: hidden; }
.ttv2-solve__bar-fill { height: 100%; width: 0; background: var(--ttv2-accent, #2563eb); transition: width .2s ease; }
.ttv2-solve__metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.ttv2-solve__status { font-size: 13px; color: var(--ttv2-text-muted, #6b7280); }
`;

function ensureStyle() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
}

const STATUS_LABEL = {
    idle: '未开始',
    running: '求解中',
    done: '已完成',
    failed: '失败',
};

/**
 * 创建求解进度页。
 * @param {object} deps
 * @param {object} deps.store store（写 solverJob / solution / diagnostics 引用）
 * @param {object} deps.api   api（solve / getSolverJob / getSolution / getDiagnostics）
 */
export function createSolveProgressView({ store, api }) {
    ensureStyle();

    const el = document.createElement('section');
    el.className = 'ttv2-view ttv2-view--solve-progress';

    const title = document.createElement('h1');
    title.className = 'ttv2-view__title';
    title.textContent = '求解进度';
    const hint = document.createElement('p');
    hint.className = 'ttv2-view__hint';
    hint.textContent = '由后端运行求解器。前端只触发并展示进度与分数，求解结果以后端返回为准。';

    const card = document.createElement('div');
    card.className = 'ttv2-view__card';

    const actionRow = document.createElement('div');
    actionRow.className = 'ttv2-view__row';
    const solveBtn = document.createElement('button');
    solveBtn.type = 'button';
    solveBtn.className = 'ttv2-view__btn';
    solveBtn.textContent = '开始求解';
    const gotoResultBtn = document.createElement('button');
    gotoResultBtn.type = 'button';
    gotoResultBtn.className = 'ttv2-view__btn ttv2-view__btn--ghost';
    gotoResultBtn.textContent = '查看结果诊断';
    actionRow.append(solveBtn, gotoResultBtn);

    const statusEl = document.createElement('div');
    statusEl.className = 'ttv2-solve__status';

    const bar = document.createElement('div');
    bar.className = 'ttv2-solve__bar';
    const barFill = document.createElement('div');
    barFill.className = 'ttv2-solve__bar-fill';
    bar.append(barFill);

    const metrics = document.createElement('div');
    metrics.className = 'ttv2-solve__metrics';

    const msg = document.createElement('div');
    msg.className = 'ttv2-view__msg';

    card.append(actionRow, statusEl, bar, metrics, msg);
    el.append(title, hint, card);

    function setMsg(text, kind) {
        msg.textContent = text || '';
        msg.classList.toggle('ttv2-view__msg--ok', kind === 'ok');
        msg.classList.toggle('ttv2-view__msg--err', kind === 'err');
    }

    function metricBox(num, label) {
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

    function renderJob() {
        const job = store.getState().solverJob || {};
        const status = job.status || 'idle';
        const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
        statusEl.textContent = `状态：${STATUS_LABEL[status] || status}`;
        barFill.style.width = `${progress}%`;

        metrics.replaceChildren();
        metrics.append(metricBox(`${progress}%`, '进度'));
        if (job.softScore != null) metrics.append(metricBox(job.softScore, '软分数'));
        const stats = job.stats || {};
        if (stats.placed != null) metrics.append(metricBox(stats.placed, '已排课节'));
        if (stats.unplaced != null) metrics.append(metricBox(stats.unplaced, '未排课节'));
        if (stats.total != null) metrics.append(metricBox(stats.total, '课节总数'));
    }

    // 触发求解：调 api.solve（后端运行），完成后用后端返回结果写引用。
    async function startSolve() {
        solveBtn.disabled = true;
        setMsg('正在请求后端求解…', null);
        store.dispatch('setSolverJob', { status: 'running', progress: 0 });
        try {
            const result = await api.solve({});
            // mock / 真实后端均返回任务结果；保存任务状态引用。
            store.dispatch('setSolverJob', {
                status: result.status || 'done',
                progress: result.progress != null ? result.progress : 100,
                softScore: result.solution ? result.solution.softScore : result.softScore,
                stats: result.stats || (result.solution && result.solution.stats),
            });
            // 完成：拉取后端 solution / diagnostics 引用（前端不自行反解）。
            if ((result.status || 'done') === 'done') {
                const solution = result.solution || await api.getSolution();
                const diagnostics = await api.getDiagnostics();
                store.dispatch('setSolution', solution);
                store.dispatch('setDiagnostics', diagnostics);
                setMsg('求解完成，可查看结果诊断。', 'ok');
            } else if ((result.status) === 'failed') {
                setMsg('求解失败，请检查数据或规则。', 'err');
            }
        } catch (err) {
            store.dispatch('setSolverJob', { status: 'failed', progress: 0 });
            setMsg(err.message || '求解请求失败', 'err');
        } finally {
            solveBtn.disabled = false;
        }
    }

    solveBtn.addEventListener('click', startSolve);
    gotoResultBtn.addEventListener('click', () => store.dispatch('goStep', 'result-diagnostics'));

    let unsub = null;

    return {
        el,
        mount() {
            unsub = store.subscribe(renderJob);
            renderJob();
        },
        update() { renderJob(); },
        destroy() {
            if (unsub) { unsub(); unsub = null; }
            el.remove();
        },
    };
}
