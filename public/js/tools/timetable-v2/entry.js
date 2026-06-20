/**
 * 智能排课 2.0 工具入口（适配 app-launcher 的 init(domEl) 契约）。
 *
 * 经 esbuild 打成 bundle（含 React-Konva 网格）：
 *   npm run build:timetable-v2
 * 产物 public/js/tools/timetable-v2/dist/workbench.bundle.js，
 * app-launcher 在 TIMETABLE_V2_ENABLED 开启时动态 import 本 bundle 并调 init。
 */
import { mountTimetableV2 } from './app/workbench.js';

let instance = null;

export function init(domEl) {
    if (!domEl) return;
    instance = mountTimetableV2(domEl);
    return instance;
}

export function destroy() {
    if (instance && typeof instance.destroy === 'function') instance.destroy();
    instance = null;
}

export default { init, destroy };
