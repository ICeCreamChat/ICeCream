# 智能排课发布历史定向导出更新

## 2026-06-10
- 已支持从发布历史详情弹窗导出指定历史版本的班级课表、教师课表、总课表。
- 后端沿用现有 `/api/tools/timetable/export`，通过 `publishedVersion` 选择 `published.history` 中的快照，不再只能导出最新发布快照。
- 历史版本导出文件名包含版本号，例如 `V1`，便于教务归档区分。
- 若请求不存在的历史版本，后端返回 `published_history_not_found`，不回退到最新版本，避免误导出。
- 发布确认弹窗中误插入的历史导出按钮已移除，避免引用不存在的 `item.version`。

## 验证
- `node --test --test-name-pattern "publication history opens" test\timetable-planner-ui.test.js`
- `node --test --test-name-pattern "selected published history" test\timetable-scheduler.test.js`
- `node --test test\timetable-planner-ui.test.js`
- `node --test test\timetable-scheduler.test.js test\timetable-solver-bridge.test.js test\timetable-export.test.js`
- `npm.cmd test`：419 tests passed
- `.\dev.bat --check`
- `cd solver && .\mvnw.cmd test`：23 tests passed
- `git diff --check`：仅 LF/CRLF 提示，无 whitespace error
