# 智能排课正式导出元数据更新

## 2026-06-10
- 正式课表导出现在会在工作簿顶部写入发布信息，包含发布状态、版本、发布时间、备注、课表编号、发布校验、课时、硬冲突和未排课时。
- 发布版或已校验课表离开系统后仍可追溯来源，便于教务归档、年级组复核和历史版本比对。
- 任课信息导出保持原始表格结构，不追加发布元数据，避免影响数据再导入或二次处理。
- 普通未发布、未校验草稿不强行写入发布信息，减少试排阶段导出噪音。

## 验证
- `node --test --test-name-pattern "publication metadata" test\timetable-export.test.js`
- `node --test test\timetable-export.test.js`
- `node --test test\timetable-scheduler.test.js test\timetable-solver-bridge.test.js test\timetable-planner-ui.test.js`
- `npm.cmd test`：421 tests passed
- `.\dev.bat --check`
- `cd solver && .\mvnw.cmd test`：23 tests passed
- `git diff --check`：仅 LF/CRLF 提示，无 whitespace error
