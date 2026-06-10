# 智能排课完整教务化更新

## 2026-06-10
- 已核对 Timefold 初始解、锁定课节、手调课节、陈旧 job、发布后不覆盖等可靠性链路，相关测试已通过。
- 已新增发布历史版本详情弹窗：右侧发布历史条目可点击查看版本、备注、快照课时、完成率、硬冲突和课节明细。
- 后续可继续评估发布版本回滚/复制、历史版本定向导出、完整发布差异详情。

## 验证
- `node --test test\timetable-planner-ui.test.js`
- `node --test test\timetable-scheduler.test.js test\timetable-solver-bridge.test.js test\timetable-export.test.js`
- `npm.cmd test`
- `.\dev.bat --check`
- `cd solver && .\mvnw.cmd test`
- `git diff --check` 仅有 LF/CRLF 提示，无 whitespace error。
