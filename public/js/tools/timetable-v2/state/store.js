/**
 * timetable-v2 / state / store.js
 *
 * 轻量订阅 / 派发 store（不引第三方）。只管理 UI 状态与后端返回引用。
 *
 * ───────────────────────── 红线（设计决策 2 / 3） ─────────────────────────
 * - store 不提供任何「构造 project / rule / activity 业务对象」的函数；业务对象
 *   一律来自 api/ 返回的后端 normalize 结果，store 只读保存其引用。
 * - store 不做任何「本地冲突判定 / 候选位计算 / 可行性推导」；不缓存可从后端
 *   重算的派生状态（冲突 / 候选位 / 未排原因）。需要时重新向后端获取。
 * - 助手草稿只能进 pendingRules 且强制 applied:false；store 没有任何直接修改
 *   project / solution 的 action（写入只能经 api/ 的写入口 → 后端）。
 */

/**
 * 创建轻量 store。
 * @template T
 * @param {T} initial 初始 state
 * @returns {{ getState: () => T, setState: (patch: Partial<T>) => void,
 *            subscribe: (listener: (state: T) => void) => () => void,
 *            dispatch: (action: string, ...args: any[]) => T }}
 */
export function createStore(initial = {}) {
    let state = { ...createInitialState(), ...initial };
    const listeners = new Set();

    function getState() {
        return state;
    }

    function notify() {
        for (const listener of listeners) listener(state);
    }

    /** 浅合并补丁并通知订阅者。仅用于 store 内部 action。 */
    function setState(patch) {
        state = { ...state, ...patch };
        notify();
    }

    /**
     * 订阅状态变更，返回取消订阅函数。
     * @param {(state: T) => void} listener
     * @returns {() => void}
     */
    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    // ───────── action 集合：这里是 store 允许的全部状态变更 ─────────
    // 红线：没有任何构造业务对象 / 本地排课计算 / 直接改 project|solution 的 action。
    const actions = {
        /** 切换当前步骤。 */
        goStep(step) {
            setState({ step });
        },
        /** 合并 UI 态补丁（选中 / 展开 / 抽屉开合等纯界面状态）。 */
        setUi(patch) {
            setState({ ui: { ...state.ui, ...patch } });
        },
        /**
         * 追加助手草稿。强制 applied:false：草稿只能待确认，
         * 不能在 store 层变成已写入项目状态（写入只经 api/ → 后端）。
         */
        addPendingRule(draft) {
            const pending = { ...draft, applied: false };
            setState({ pendingRules: [...state.pendingRules, pending] });
        },
        /** 清空待确认草稿（如确认写入成功后由调用方清理）。 */
        clearPendingRules() {
            setState({ pendingRules: [] });
        },
        /** 只存后端返回的 project 引用。 */
        setProject(p) {
            setState({ project: p });
        },
        /** 只存后端返回的 solution 引用。 */
        setSolution(s) {
            setState({ solution: s });
        },
        /** 只存后端返回的 diagnostics 引用。 */
        setDiagnostics(d) {
            setState({ diagnostics: d });
        },
        /** 只存后端返回的 solverJob 引用。 */
        setSolverJob(j) {
            setState({ solverJob: j });
        },
    };

    /**
     * 派发一个具名 action。
     * @param {keyof typeof actions} action
     */
    function dispatch(action, ...args) {
        const handler = actions[action];
        if (typeof handler !== 'function') {
            throw new Error(`未知 action: ${action}`);
        }
        handler(...args);
        return state;
    }

    return { getState, setState, subscribe, dispatch };
}

/**
 * 初始 state。后端返回引用初始为 null，需要时由 api/ 拉取后经 setXxx 存入。
 */
function createInitialState() {
    return {
        step: 'data-prep',           // 当前步骤
        ui: {},                      // 各页面 UI 态（选中 / 展开 / 抽屉开合）
        pendingRules: [],            // 助手草稿，每条 applied:false
        project: null,               // 后端返回引用
        solution: null,              // 后端返回引用
        diagnostics: null,           // 后端返回引用
        solverJob: null,             // 后端返回引用
    };
}
