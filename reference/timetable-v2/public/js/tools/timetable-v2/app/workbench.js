/**
 * timetable-v2 / app / workbench.js
 *
 * 智能排课 2.0 工作台壳。用 createThreePaneLayout 搭三栏：
 *   - nav：createStepNav（点击 dispatch('goStep', step)）
 *   - main：按 store.step 切换七个 view（挂当前、destroy 上一个）
 *   - aside：createInsightPanel（随 diagnostics 更新）
 *
 * ───────────────────────── 红线（会被审查） ─────────────────────────
 * - 不 import 任何 gateway/services/timetable-v2 后端模块。
 * - 不在前端算冲突 / 候选 / 可行性；只读 solution / diagnostics 展示。
 * - 助手解析只进 pendingRules(applied:false)；任何「确认写入」只经 api 写入口。
 * - 不在前端构造 project / rule 业务对象。
 * - store ↔ React 网格桥接：网格只通过 view 的 props 收数据、通过回调发意图，
 *   回调里调 api 写入口（前端唯一写路径经 api）。
 *
 * 导出：
 *   createTimetableV2Workbench(rootEl) → { el, destroy }
 *   mountTimetableV2(rootEl)           → 便捷入口，等价 create + 自动挂载
 */

import { createStore } from '../state/store.js';
import * as api from '../api/index.js';

import { createThreePaneLayout } from '../components/three-pane-layout.js';
import { createStepNav, STEPS } from '../components/step-nav.js';
import { createInsightPanel } from '../components/insight-panel.js';

import { createDataPrepView } from '../views/data-prep.js';
import { createRuleInputView } from '../views/rule-input.js';
import { createRuleReviewView } from '../views/rule-review.js';
import { createSolveProgressView } from '../views/solve-progress.js';
import { createResultDiagnosticsView } from '../views/result-diagnostics.js';
import { createManualAdjustView } from '../views/manual-adjust.js';
import { createPublishExportView } from '../views/publish-export.js';

// step key → view 工厂。新增步骤只在此登记，壳逻辑不变。
const VIEW_FACTORIES = {
    'data-prep': createDataPrepView,
    'rule-input': createRuleInputView,
    'rule-review': createRuleReviewView,
    'solve-progress': createSolveProgressView,
    'result-diagnostics': createResultDiagnosticsView,
    'manual-adjust': createManualAdjustView,
    'publish-export': createPublishExportView,
};

// 默认首步（与 STEPS 首项一致，兜底防止脏 step）。
const DEFAULT_STEP = (STEPS[0] && STEPS[0].step) || 'data-prep';

/**
 * 创建工作台。
 * @param {HTMLElement} rootEl 宿主容器（工作台 el 会被挂入此节点）
 * @returns {{ el: HTMLElement, destroy: () => void, store: object }}
 */
export function createTimetableV2Workbench(rootEl) {
    const store = createStore({ step: DEFAULT_STEP });

    const el = document.createElement('section');
    el.className = 'ttv2-workbench';
    el.setAttribute('aria-label', '智能排课工作台');

    const frame = document.createElement('div');
    frame.className = 'ttv2-frame';

    const topbar = document.createElement('header');
    topbar.className = 'ttv2-topbar';

    const identity = document.createElement('div');
    identity.className = 'ttv2-identity';
    identity.innerHTML = `
        <span class="ttv2-identity__icon" aria-hidden="true"><i data-lucide="calendar-check"></i></span>
        <span class="ttv2-identity__copy">
            <p class="ttv2-eyebrow">课堂工具箱 / Timetable V2</p>
            <h1 class="ttv2-title" id="ttv2-project-title">智能排课</h1>
            <p class="ttv2-subtitle" id="ttv2-project-subtitle">正在读取排课项目...</p>
        </span>
    `;

    const titleEl = identity.querySelector('#ttv2-project-title');
    const subtitleEl = identity.querySelector('#ttv2-project-subtitle');

    const statusStrip = document.createElement('div');
    statusStrip.className = 'ttv2-status-strip';

    function makeKpi(label) {
        const item = document.createElement('div');
        item.className = 'ttv2-kpi';
        const labelEl = document.createElement('span');
        labelEl.className = 'ttv2-kpi__label';
        labelEl.textContent = label;
        const valueEl = document.createElement('span');
        valueEl.className = 'ttv2-kpi__value';
        valueEl.textContent = '—';
        item.append(labelEl, valueEl);
        statusStrip.append(item);
        return valueEl;
    }

    const kpis = {
        data: makeKpi('数据'),
        rules: makeKpi('规则'),
        solve: makeKpi('求解'),
        quality: makeKpi('质量'),
        publish: makeKpi('发布'),
    };

    topbar.append(identity, statusStrip);

    // 三栏布局
    const layout = createThreePaneLayout({ narrowBreakpoint: 900 });

    // 步骤导航：点击只转 dispatch('goStep')，不在壳里做业务判断。
    const stepNav = createStepNav({
        current: store.getState().step,
        onGoStep: (step) => store.dispatch('goStep', step),
    });
    layout.setNav(stepNav.el);

    // 洞察助手：只读后端 diagnostics / report / unsupported。
    const insight = createInsightPanel({
        diagnostics: store.getState().diagnostics,
        migrationReport: store.getState().migrationReport,
        unsupportedRules: store.getState().unsupportedRules,
    });
    layout.setAside(insight.el);

    frame.append(topbar, layout.el);
    el.append(frame);
    if (rootEl) rootEl.append(el);
    if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 2 } });

    // ───────── 主任务区 view 切换 ─────────
    let currentStep = null;     // 当前已挂载的 step key
    let currentView = null;     // 当前 view 实例 { el, mount, update, destroy }

    function mountStep(step) {
        const factory = VIEW_FACTORIES[step] || VIEW_FACTORIES[DEFAULT_STEP];
        // 销毁上一个 view（含 React 网格 view，其 destroy() 内部 unmountGrid 释放 root）。
        if (currentView) {
            currentView.destroy();
            currentView = null;
        }
        const view = factory({ store, api });
        currentView = view;
        currentStep = step;
        layout.setMain(view.el);
        view.mount();
    }

    // 订阅：step 变化切 view；diagnostics 变化刷新洞察区；narrow 抽屉随 ui 开合。
    const unsub = store.subscribe((state) => {
        // step 变化时才重挂 view（同 step 内的数据变化由 view 自身订阅处理）。
        const targetStep = VIEW_FACTORIES[state.step] ? state.step : DEFAULT_STEP;
        if (targetStep !== currentStep) {
            stepNav.update({ current: targetStep });
            mountStep(targetStep);
        }
        updateChrome(state);
        // 洞察区随后端 diagnostics / report 引用更新。
        insight.update({
            diagnostics: state.diagnostics,
            migrationReport: state.migrationReport,
            unsupportedRules: state.unsupportedRules,
            publishResult: state.publishResult,
        });
        // 窄屏抽屉开合（纯 UI 态）。
        layout.update({ asideOpen: !!(state.ui && state.ui.asideOpen) });
    });

    // 首次挂载当前步骤。
    mountStep(store.getState().step);
    updateChrome(store.getState());
    bootstrap();

    let destroyed = false;
    return {
        el,
        store,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            unsub();
            if (currentView) { currentView.destroy(); currentView = null; }
            stepNav.destroy();
            insight.destroy();
            layout.destroy();
            el.remove();
        },
    };

    function updateChrome(state) {
        const project = state.project;
        const solution = state.solution || {};
        const stats = solution.stats || state.solverJob?.stats || {};
        const hard = Array.isArray(solution.hardConflicts) ? solution.hardConflicts.length : 0;
        const unplaced = Array.isArray(solution.unplaced) ? solution.unplaced.length : 0;
        const caps = state.capabilities || {};
        const importSources = Array.isArray(caps.importSources) ? caps.importSources.length : 0;

        titleEl.textContent = project?.name || '智能排课';
        subtitleEl.textContent = project
            ? `修订 ${project.revision || 0} · ${project.classes?.length || 0} 班 · ${project.teachers?.length || 0} 位教师`
            : (state.bootstrap?.needsMigration ? '尚未创建 V2 项目，可从数据准备导入' : '尚未加载项目');

        kpis.data.textContent = project ? `${project.activityPlans?.length || 0} 计划` : `${importSources || 0} 导入源`;
        kpis.rules.textContent = `${project?.constraints?.length || 0} 条`;
        kpis.solve.textContent = state.solverJob?.status === 'running'
            ? '求解中'
            : (solution.placements ? `${solution.placements.length} 已排` : '未求解');
        kpis.quality.textContent = solution.placements ? `${hard} 冲突 / ${unplaced} 未排` : '待生成';
        kpis.publish.textContent = state.publishResult?.published ? '已发布' : '未发布';
    }

    async function bootstrap() {
        store.dispatch('setLoading', 'bootstrap', true);
        try {
            const boot = await api.getBootstrap();
            store.dispatch('setBootstrap', boot);
            store.dispatch('setError', null);
        } catch (error) {
            store.dispatch('setError', error.message || '读取项目失败');
        } finally {
            store.dispatch('setLoading', 'bootstrap', false);
        }
    }
}

/**
 * 便捷入口：创建并挂载工作台到 rootEl。
 * @param {HTMLElement} rootEl
 * @returns {{ el: HTMLElement, destroy: () => void, store: object }}
 */
export function mountTimetableV2(rootEl) {
    return createTimetableV2Workbench(rootEl);
}
