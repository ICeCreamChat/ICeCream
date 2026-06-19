/**
 * Phase 3 导入器测试聚合入口。
 * 实际用例拆分在 timetable-v2-importers-{legacy,excel,crystal,yqd}.test.js（各自聚焦一个导入器）。
 * 本 barrel 让文档命令 `node --test test/timetable-v2-importers.test.js` 一次跑全 4 个套件。
 */
import './timetable-v2-importers-legacy.test.js';
import './timetable-v2-importers-excel.test.js';
import './timetable-v2-importers-crystal.test.js';
import './timetable-v2-importers-yqd.test.js';
