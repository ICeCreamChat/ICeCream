/**
 * timetable-v2 / components / timetable-grid / __probe.entry.jsx
 *
 * 仅供本地浏览器验证（非生产）。因浏览器无法直接解析 `react` / `react-konva`
 * 裸模块说明符，验证页用本入口经 esbuild 打包出可直接 import 的 ESM bundle，
 * 与项目「src/*.jsx → esbuild bundle → public/*.js」既有 React 范式一致。
 *
 * 用法（在本目录下生成可被 __probe.html import 的 bundle）：
 *   node_modules/.bin/esbuild \
 *     public/js/tools/timetable-v2/components/timetable-grid/__probe.entry.jsx \
 *     --bundle --format=esm --jsx=automatic --loader:.jsx=jsx \
 *     --outfile=public/js/tools/timetable-v2/components/timetable-grid/__probe.bundle.js
 */

import { mountGrid } from './mount.js';
import { sampleSolution } from '../../api/mock/solution.sample.js';

// 5×6 最小日历 + 名称字典（与 project.sample.js 同形，验证够用即可）。
const project = {
    name: '验证用样例',
    calendar: { weekdays: 5, periodsPerDay: 6, periodTimes: [] },
    classes: [{ id: 'c1', name: '一班' }, { id: 'c2', name: '二班' }],
    teachers: [
        { id: 't1', name: '张老师' },
        { id: 't2', name: '李老师' },
        { id: 't3', name: '王老师' },
    ],
    subjects: [
        { id: 's1', name: '语文' },
        { id: 's2', name: '数学' },
        { id: 's3', name: '物理' },
    ],
    rooms: [{ id: 'r1', name: '物理实验室' }],
};

const el = document.getElementById('grid-root');
mountGrid(el, {
    project,
    solution: sampleSolution,
    conflictCells: [],
    onCellClick: (cell) => {
        // 仅打印，验证「事件回调出」；网格自身不改任何数据。
        // eslint-disable-next-line no-console
        console.log('[probe] onCellClick', cell);
    },
});
