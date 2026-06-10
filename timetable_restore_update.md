# 智能排课发布历史恢复更新

## 2026-06-10
- 新增 `POST /api/tools/timetable/schedule/published/restore`。
- 指定历史版本可恢复为当前草稿，恢复后 `schedule.source` 为 `published_history_restored`。
- 恢复后发布状态为 `draft_changed`，不会直接变成已发布，仍需要教务复核并重新发布。
- 发布历史详情弹窗新增“恢复为草稿”按钮，前端成功后停止旧优化轮询并刷新课表。

## 验证
- `node --test --test-name-pattern "restores a published history" test\timetable-scheduler.test.js`
- `node --test --test-name-pattern "publication history opens" test\timetable-planner-ui.test.js`
- `node --test test\timetable-planner-ui.test.js`
- `node --test test\timetable-scheduler.test.js test\timetable-solver-bridge.test.js test\timetable-export.test.js`
- `npm.cmd test`
- `.\dev.bat --check`
- `cd solver && .\mvnw.cmd test`
- `git diff --check` 仅有 LF/CRLF 提示，无 whitespace error。
