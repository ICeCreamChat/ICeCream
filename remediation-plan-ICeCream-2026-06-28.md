# Remediation Plan

**Project:** ICeCream
**Based on audit:** [audit-report-ICeCream-2026-06-28.md](./audit-report-ICeCream-2026-06-28.md)
**Target release:** Timetable V2 hardening / Gateway safety baseline
**Language:** 中文
**Output format:** Markdown

---

## 执行原则

这份计划不是推倒重写计划。当前 V2 排课核心质量可继续保留，修复重点是把边界补硬：安全边界、发布可信边界、并发保存边界、外部调用预算、发布门禁。

执行时按 Phase 顺序推进。每个 Phase 完成后必须跑对应验证命令，不要跨 Phase 混改大重构。能用小改动消除真实风险时，不做“大而全”的重写。

---

## 执行记录（2026-06-28 / Codex）

### 已完成

- Phase 1：Gateway 默认绑定本机；`ALLOW_REMOTE=true` 才允许远程绑定；远程绑定缺少 `ICECREAM_LOCAL_TOKEN` 时启动拒绝；Manim jobs/failures/replay/patch/layout-rebuild 管理面接入本地 token guard。
- Phase 2：Timetable V2 `saveProject` 增加 revision/CAS；`/schedule/publish` 改为服务端根据 `project + solution.placements` 重建并检测硬冲突/未排；发布成功持久化 `publishedSnapshot` / `publishedHistory` / `solutionHash`。
- Phase 3：新增 provider fetch budget helper；OCR/SiliconFlow 外部调用接入 timeout 与错误分类；反馈日志/截图新增保留期清理函数与 `npm run cleanup:feedback`；新增 GitHub Actions CI；生产 5xx 统一返回通用中文错误与 `requestId`。
- Phase 4 quick wins：V2 数据准备/规则输入表单 label 显式绑定控件；座位规划纯算法迁移到 `shared/seating/`，前端旧路径保留 re-export，Gateway 静态托管 `/shared`；新增后端禁止 import `public/**` 守门；新增 vendor manifest 与 bundle 体积守门。
- Phase 4 拆分进展：`gateway/routes/tools.js` 已拆为 `gateway/routes/tools/seating/*` 子路由；`public/js/tools/seating-planner.js` 的座位 API 调用已集中到 `public/js/tools/seating-planner/api-client.js`；导出面板已抽到 `public/js/tools/seating-planner/export-panel.js`；反馈/截图/诊断面板已抽到 `public/js/tools/seating-planner/feedback-panel.js`；AI assistant/chat/suggestion 面板已抽到 `public/js/tools/seating-planner/assistant-panel.js`；名单/图片导入/名单编辑面板已抽到 `public/js/tools/seating-planner/roster-panel.js`；布局预览/编辑/确认/生成入口已抽到 `public/js/tools/seating-planner/layout-preview-panel.js`；座位详情/课桌角标/弹出详情面板已抽到 `public/js/tools/seating-planner/seat-detail-panel.js`；实时网格/拖拽/右键菜单/过道编辑已抽到 `public/js/tools/seating-planner/grid-panel.js`；主文件通过 `Object.assign(SeatingPlanner.prototype, ...)` 挂载面板方法，测试改为验证模块边界。
- 新增/更新测试覆盖：provider timeout、feedback cleanup、production 5xx 脱敏、V2 publish 服务端重算、revision 并发保存、shared 静态模块、import graph、vendor/bundle governance、V2 label DOM 验证、座位 planner API/export/feedback/assistant/roster/layout-preview/seat-detail/grid 模块边界。

### 本轮未做

- 本地代码修复与计划内模块拆分已完成；未执行真实 GitHub Actions 远端结果确认，已新增 `.github/workflows/ci.yml`，需要 push 后由 GitHub 跑一次确认。
- 未运行 `npm run cleanup:feedback` 清理真实本地 `logs/`，避免在未确认保留策略前删除用户反馈附件；清理逻辑已用临时目录测试覆盖。

### 本地验证

- `npm run build:timetable-v2`
- `node test/timetable-v2-ui-verify.mjs`
- `node test/timetable-v2-integration-verify.mjs`
- `node --check public/js/tools/seating-planner.js && node --check public/js/tools/seating-planner/grid-panel.js`
- `node --test test/seating-planner-ui.test.js test/seating-image-import.test.js test/mobile-responsive.test.js test/ai-status.test.js test/gateway-modules.test.js test/seating-arrange-route.test.js test/seating-chat.test.js test/seating-feedback.test.js test/seating-export-xlsx.test.js test/seating-suggestions.test.js`：105 passed, 0 failed
- `npm test`：487 passed, 0 failed

---

## Phase 1: Critical Fixes / Immediate Boundary Hardening (0.5-1 day)

审计没有发现 Critical 级别问题，但有 1 个 High 问题会影响所有 API 边界，应按立即修复处理。

| # | Finding | Fix | Owner | Est. effort | Verification |
|---|---------|-----|-------|-------------|--------------|
| 1 | Gateway API 缺少应用级认证和本地绑定硬边界 | 增加 `HOST` 配置，默认 `127.0.0.1`；`ALLOW_REMOTE=true` 才允许非 loopback；给 `/api/**` 增加本地 token 中间件，管理/调试类接口必须校验 token | Claude | 0.5-1.5 days | 新增 auth/host 测试；`npm test` |
| 2 | Manim 作业/失败/重放/patch 管理面外露 | 将 `/api/manim/jobs`、`/api/manim/failures`、`/api/manim/failures/:eventId/replay`、`/api/manim/patch`、`/api/manim/layout-rebuild` 纳入更严格的 token 校验；普通渲染接口保留正常 UI 可用 | Claude | 0.5 day | 未带 token 返回 401；带 token 正常；现有 Manim tests 不破 |

### Implementation Notes

- 默认本机使用体验不能被破坏。前端同源请求可以通过启动时注入或同源 cookie/header 自动带 token。
- 不要把 token 写入 Git。`.env` 仍然保留本地私有。
- CORS 继续保留，但不要把 CORS 当认证。
- 如果短期不想影响所有 `/api/**`，至少先保护 Manim 管理面、OCR/AI 成本接口、V2 发布接口。

### Verification for Phase 1

- `npm test`
- 新增测试：
  - 未带 token 访问 Manim 管理接口返回 401。
  - 默认 `HOST` 为 `127.0.0.1`。
  - 设置 `ALLOW_REMOTE=true` 后才允许远程绑定。
  - 现有同源 UI/API 流程仍可用。

---

## Phase 2: High Severity Fixes / Timetable V2 Data Trust (1-2 days)

这一阶段修 V2 排课最关键的正确性边界。目标是：发布和保存不能再相信客户端口头声明。

| # | Finding | Fix | Owner | Est. effort | Verification |
|---|---------|-----|-------|-------------|--------------|
| 1 | Timetable V2 发布接口信任客户端传入的冲突状态 | `/schedule/publish` 服务端根据 `project + solution.placements` 重建解并运行硬冲突检测；客户端传来的 `hardConflicts` 仅作为展示数据，不作为门禁依据 | Claude | 0.5-1 day | 伪造 clean solution 的 API test 必须 422 |
| 2 | Timetable V2 本地存储缺少乐观并发控制 | 给 project 增加 `revision` 或 `updatedAt` 版本；保存接口要求 `expectedRevision`；不匹配返回 409 和 `reason: version_conflict` | Claude | 0.5-1 day | 并发保存测试：旧 revision 保存失败且不覆盖 |
| 3 | 发布结果没有服务端持久快照 | 发布成功时保存 `publishedSnapshot` 或 `publishedHistory` 条目，包含 `projectRevision`、`solutionHash`、`publishedAt`、`placements`、`softScore` | Claude | 0.5 day | 发布后 bootstrap/load 能看到发布状态 |

### Implementation Notes

- 优先复用现有 `detectHardConflicts`、`buildContext`、`createProject`、`createSolution` 等 V2 核心函数。
- 不要把 publish 做成“再跑一次完整求解器”才允许发布；发布应校验提交解是否满足硬约束，而不是重新生成新解。
- 前端 `version_conflict` 文案已经存在，后端补 409 后前端应能接上；若不完整，再补 UI 处理。
- 如果 `revision` 会影响 mock/sample，需要同步更新 `public/js/tools/timetable-v2/api/mock/*.js` 和相关测试夹具。

### Verification for Phase 2

- `node --test test/timetable-v2-api.test.js`
- `node --test test/timetable-v2-*.test.js`
- `npm test`
- 新增测试：
  - 伪造 `hardConflicts: []` 但 placements 实际冲突，发布返回 422。
  - 伪造 `unplaced: []` 但 placements 缺活动，发布返回 422。
  - 两份旧项目副本并发保存，第二次保存返回 409。
  - 发布成功后有服务端 snapshot/revision 可追溯。

---

## Phase 3: Medium Severity Fixes / Runtime Reliability (1-2 days)

这一阶段修稳定性、隐私、发布门禁。目标是让本地工具在上游 AI、日志、CI 这些现实环境里不轻易翻车。

| # | Finding | Fix | Owner | Est. effort | Verification |
|---|---------|-----|-------|-------------|--------------|
| 1 | 部分外部模型调用没有明确超时和重试预算 | 新增共享 helper，例如 `fetchJsonWithTimeout` / `callModelWithBudget`；给 `gateway/services/ocr.js` 和 `services/solver/siliconflow.js` 的外部 fetch 统一加 timeout、错误分类和可读错误 | Claude | 0.5-1 day | mock 永不返回的 fetch，断言按预算超时 |
| 2 | 反馈日志和截图资产没有保留期与删除路径 | 增加 `FEEDBACK_RETENTION_DAYS`；实现 cleanup 函数和 `npm run cleanup:feedback`；启动或命令执行时清理过期 JSONL 行和截图 | Claude | 0.5 day | 过期文件被删除，近期文件保留 |
| 3 | 缺少 CI 和发布前自动门禁 | 新增 `.github/workflows/ci.yml`，运行 `npm ci`、`npm test`、`npm run build:timetable-v2`、V2 UI/integration verify | Claude | 0.5 day | GitHub Actions 通过 |
| 4 | 多个路由把内部错误消息直接返回给客户端 | 增加统一 error mapper；production 5xx 返回通用中文错误 + `requestId`，完整错误只进日志；dev 可保留 details | Claude | 0.5-1 day | mock 内部 URL 错误，响应不泄露内部信息 |

### Implementation Notes

- 外部调用不要只加 timeout，还要统一错误 reason：`provider_timeout`、`provider_bad_response`、`provider_unavailable`、`validation_failed`。
- feedback cleanup 要小心路径安全，只清理 `logs/seating-feedback-assets` 和对应 JSONL，不碰用户项目数据。
- CI 不要一开始塞太多重任务。先把现有可靠命令跑起来，再逐步加 audit/depcheck。
- 错误映射不要破坏前端已依赖的业务 reason，例如 `hard_conflicts_exist`、`unplaced_lessons`、`version_conflict`。

### Verification for Phase 3

- `npm test`
- `npm run build:timetable-v2`
- `node test/timetable-v2-ui-verify.mjs`
- `node test/timetable-v2-integration-verify.mjs`
- 新增测试：
  - fetch timeout 不挂死。
  - feedback cleanup 不删除近期数据。
  - production 5xx 不返回内部 `error.message`。

---

## Phase 4: Scheduled Improvements / Architecture Debt Reduction (3-7 days)

这一阶段不是上线阻断项，但会显著降低后续维护成本。目标是把旧课堂工具箱中最容易继续变烂的部分拆开。

| # | Finding | Fix | Owner | Est. effort | Notes |
|---|---------|-----|-------|-------------|-------|
| 1 | 后端 seating 服务直接依赖 public 前端模块 | 把 `classroom-layout`、`seating-core` 中的纯算法搬到 `shared/seating/` 或 `gateway/services/seating-domain/`；前后端都从纯模块导入 | Claude | 1-2 days | 先移动纯函数，不改行为 |
| 2 | 旧课堂工具箱存在多处巨石文件 | 拆 `gateway/routes/tools.js` 为 seating、feedback、ocr、export、suggestions 子路由；拆 `seating-planner.js` 为 roster/layout/assistant/export/feedback 面板 | Claude | 3-7 days | 分批小提交，保持测试绿 |
| 3 | V2 表单 label 没有显式绑定控件 | `labeledField` 自动生成 id，设置 `label.htmlFor`；补 DOM test | Claude | 30 min | 可作为 quick win 先做 |
| 4 | vendor/bundle 缺来源和体积守门 | 增加 vendor manifest；CI 增加 bundle size warning；检查 `dist/workbench.bundle.js` 是否和源码同步 | Claude | 0.5-1 day | 不删除 vendor，只补治理 |

### Verification for Phase 4

- 每拆一个模块都跑 `npm test`。
- 增加 import graph guard：禁止 `gateway/**` import `public/**`，迁移期白名单必须有到期说明。
- `npm run build:timetable-v2`
- UI smoke：打开课堂工具箱、智能排课、智能排座核心页面。

---

## Regression Test Checklist

- [x] Gateway 默认绑定 `127.0.0.1`。
- [x] `ALLOW_REMOTE=true` 才允许非 loopback host。
- [x] Manim 管理接口无 token 返回 401。
- [x] 同源前端请求仍能正常调用必要 API。
- [x] `/schedule/publish` 对伪造 clean solution 返回 422。
- [x] `/schedule/publish` 服务端重算 hard conflicts。
- [x] 项目并发保存时旧 revision 返回 409 `version_conflict`。
- [x] 发布成功后有可追溯 `publishedSnapshot` / `publishedHistory`。
- [x] 外部模型调用超时后返回可读错误，不挂住请求。
- [x] feedback cleanup 删除过期日志和截图，保留近期数据。
- [x] production 5xx 响应不泄露内部 URL、provider 细节或堆栈。
- [x] V2 表单 label 与控件显式关联。
- [x] `gateway/**` 不再直接 import `public/**`，或白名单有明确迁移期限。
- [x] CI 已配置运行 `npm ci`、`npm test`、`npm run build:timetable-v2`；远端绿色状态需 push 后确认。

---

## Acceptance Criteria

- 所有 High finding 已修复。
- Phase 2 的 V2 发布可信边界和保存并发边界已修复。
- 所有已修复 finding 都有对应回归测试。
- `npm test` 通过。
- `npm run build:timetable-v2` 通过。
- V2 UI/integration verify 通过。
- GitHub Actions 首次绿色通过。
- 不引入新的敏感文件、token、`.env` 内容或用户数据。
- 不删除 `logs/`、`data/timetable/projects.json`、反馈附件、测试夹具、vendor/offline assets。

---

## Claude 执行提示

建议把这份计划拆成 4 个独立 PR 或 4 个连续提交：

1. `fix(gateway): harden local api boundary`
2. `fix(timetable-v2): verify publish and save revisions`
3. `fix(runtime): add provider budgets and release gates`
4. `refactor(seating): extract shared domain boundaries`

每个提交前都执行：

```bash
npm test
npm run build:timetable-v2
```

涉及 V2 的提交额外执行：

```bash
node --test test/timetable-v2-*.test.js
node test/timetable-v2-ui-verify.mjs
node test/timetable-v2-integration-verify.mjs
```

不要在同一个提交里混合格式化、重命名、大量移动和行为修改。先补测试，再改实现；如果必须移动文件，保持函数签名和测试不变。
