# 智能排课最新发布版恢复更新

## 2026-06-10
- 已支持将最新已发布快照恢复为当前草稿，适用于草稿被手调、重排或改坏后快速回到发布版。
- 复用现有 `POST /api/tools/timetable/schedule/published/restore`：不传 `version` 时恢复 `published.snapshot`，传 `version` 时仍恢复指定历史版本。
- 右侧“发布前校验”在草稿已变化且存在发布快照时显示 `恢复发布版` 按钮。
- 恢复后课表 `source` 仍标记为 `published_history_restored`，发布状态保持 `draft_changed`，要求教务复核后重新发布，避免误把恢复动作当作正式发布。
- 恢复动作会停止旧后台优化轮询并清空选中课节，避免旧 Timefold job 覆盖恢复后的草稿。

## 验证
- `node --test --test-name-pattern "latest published snapshot" test\timetable-scheduler.test.js`
- `node --test --test-name-pattern "published snapshot|publish action" test\timetable-planner-ui.test.js`
- `node --test test\timetable-planner-ui.test.js`
- `node --test test\timetable-scheduler.test.js test\timetable-solver-bridge.test.js test\timetable-export.test.js`
- `npm.cmd test`：420 tests passed
- `.\dev.bat --check`
- `cd solver && .\mvnw.cmd test`：23 tests passed
- `git diff --check`：仅 LF/CRLF 提示，无 whitespace error
