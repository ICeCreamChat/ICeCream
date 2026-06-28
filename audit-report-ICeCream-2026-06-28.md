# Fuck My Shit Mountain Audit Report

**Project:** ICeCream
**Audit mode:** full
**Date:** 2026-06-28
**Reviewer:** Codex GPT-5

---

## 1. Executive Summary

ICeCream 现在不是一座纯粹的烂山。智能排课 V2 的核心层明显比旧课堂工具代码健康：领域模型、约束注册、求解器、诊断、导入器、前端 V2 入口都已经模块化，测试也很实在。当前验证结果是 `npm test` 通过 476/476，`npm run build:timetable-v2` 通过，V2 bundle 约 2.1MB。OpenSpec 的 V2 相关变更已经归档，说明 Phase 1-7 和后续自然语言规则从流程上已收口。

但项目整体还没到“可放心长期演进”的状态。最危险的地方不是 V2 求解器，而是网关安全边界、发布可信边界、数据并发边界和旧课堂工具箱的大文件耦合。现在很多接口仍按“本地自用工具”假设设计：默认监听没有显式 host 限制，API 没有应用级认证，Manim 作业/失败重放/patch 类接口直接挂在网关上。排课 V2 发布接口也还相信客户端传来的 `hardConflicts` 和 `unplaced`，这在工程上属于“门口装了锁，但钥匙由访客自己声明”。

结论：V2 排课核心值得继续做，不建议推倒重写。下一步应该先加硬边界：本地绑定/认证、发布前服务端重算、项目版本冲突控制、CI 发布门禁。等这些补上，才值得继续扩自然语言规则和 UI 体验。

### Score Dashboard

```
Security        █████░░░░░  5.0  C   本地工具假设太强，API 无认证，Manim 管理面外露
Stability       ███████░░░  7.0  A   测试充足，但外部模型调用和并发保存仍有风险
Performance     ████████░░  8.0  A   V2 求解性能好，bundle/旧 UI 体积需控
Testing         ████████░░  8.0  A   476 个测试通过，缺 CI 和恶意/并发场景
Maintainability ██████░░░░  6.0  B   V2 清晰，旧 seating/message 模块仍是巨石
Design          ███████░░░  7.0  A   V2 方向正确，旧模块边界违反依赖方向
Release         █████░░░░░  5.0  C   无 GitHub Actions，缺稳定发布门禁和回滚说明
─────────────────────────────────────
Overall         ███████░░░  6.6  B
```

Each dimension scored 0.0-10.0. **Higher = better (10 = clean, 0 = shit mountain).** Scores are judgment-based, not formula-based. See `rubrics/scoring.md` for anchor descriptions.

### Finding Statistics

| Severity | Count | Confirmed | Suspected |
|----------|-------|-----------|-----------|
| Critical | 0 | 0 | 0 |
| High | 1 | 1 | 0 |
| Medium | 7 | 7 | 0 |
| Low | 2 | 2 | 0 |
| Info | 0 | 0 | 0 |
| **Total** | **10** | **10** | **0** |

## 2. Project Map

ICeCream 是一个 Node/Express 网关 + 静态前端 + 多个本地/远端 AI 工具的课堂工具箱。入口是 `gateway/server.js`，应用构造在 `gateway/app.js`，路由由 `gateway/routes/index.js` 挂载到 `/api/message`、`/api/chat`、`/api/geogebra`、`/api/manim`、`/api/solver`、`/api/tools/timetable-v2` 和 `/api/tools`。

智能排课 V2 的后端核心位于 `gateway/services/timetable-v2/`：`domain/` 负责项目、活动、日历、解结构；`constraints/` 负责 DSL、硬约束、软约束和自然语言规则；`solver/` 负责构造、压力评分、换位改进、审计；`diagnostics/` 负责解释、报告和建议；`importers/` 负责旧项目、水晶、Excel、一全达类数据；`api/` 负责 V2 HTTP 和本地 JSON 存储。前端 V2 位于 `public/js/tools/timetable-v2/`，入口是 `entry.js`，状态层在 `state/store.js`，视图分为数据准备、规则输入、求解、诊断、手动调整、发布导出。

旧课堂工具箱仍然存在较重的巨石模块：`public/js/tools/seating-planner.js` 7352 行，`gateway/services/seating-arrange.js` 3056 行，`public/js/core/message-handler.js` 1906 行，`gateway/routes/tools.js` 722 行。这些模块把 UI、接口、AI prompt、业务规则、降级逻辑混在一起，是后续改动最容易牵一发动全身的区域。

安全边界目前主要靠 CORS、静态安全头、上传白名单和内存限流。它们能挡一部分误用，但不能替代认证、host 绑定和敏感管理接口隔离。持久化边界主要是本地 JSON、日志和上传目录，排课 V2 写入用了 tmp + rename 原子写，但没有项目版本/CAS 冲突控制。

### Coverage Matrix

| Dimension | Coverage | Evidence inspected | Exclusions / limits |
|-----------|----------|--------------------|---------------------|
| Architecture | High | `gateway/app.js`, `gateway/routes/index.js`, `gateway/services/timetable-v2/**`, 旧 seating/message 大文件统计 | 未逐行审完所有 Manim Python 代码 |
| Security | High | `gateway/server.js`, `gateway/middleware/core.js`, `gateway/security.js`, `gateway/routes/manim.js`, `gateway/routes/tools.js` | 未做主动攻击或端口扫描 |
| Stability | High | 外部 fetch、V2 store、API 错误处理、测试运行 | 未长时间压测 |
| Performance | Medium | V2 benchmark 测试、bundle 构建大小、巨石文件行数 | 未做浏览器真实 FPS/内存 profile |
| Testing | High | `npm test`, V2 test files, UI verify/integration verify 文件 | 未覆盖 CI 真实环境 |
| Maintainability | High | 行数统计、模块边界、路由职责 | 未对每个函数复杂度自动量化 |
| Design | High | V2 分层、旧模块依赖方向、OpenSpec archive | 未重画完整架构图 |
| Release | Medium | `package.json`, `.github` 不存在、构建脚本 | 未检查 GitHub 仓库远端设置 |
| Documentation | Medium | `OpenSpec/project.md`, `OpenSpec/roadmap.md`, archived specs/tasks | 未逐字审 README 全部段落 |
| Configuration | High | `gateway/config/environment.js`, `gateway/server.js`, package scripts | 未审所有 `.env` 变体 |
| Observability | Medium | logger、health、反馈日志、错误返回 | 未接入真实日志平台 |
| Data Integrity | High | V2 publish/store/import/export 路径 | 未对真实学校大数据集做恢复演练 |
| Privacy | Medium | seating feedback、logs、uploads | 未审历史本地日志内容 |
| Accessibility | Medium | V2 rule input/step nav、UI verify | 未跑自动 a11y 工具 |
| Supply Chain | Medium | `package-lock.json`, `requirements.txt`, vendor/bundle 结构 | 未做 `npm audit` 或 pip 漏洞扫描 |
| Cost | Medium | LLM/OCR/Manim endpoints、rate limit、timeouts | 未统计真实 token 和账单 |
| AI Safety | Medium | prompt/API routes、V2 NL parser、AI response validation | 未做 prompt injection 红队集 |
| Fallback | Medium | OCR/AI fallback、Manim fallback、V2 unsupported 规则 | 未审所有 catch 分支 |
| Testing Authenticity | High | 476 个测试输出、V2 benchmark、API tests | 未做 mutation testing |
| Type Safety | Medium | JS validation style、V2 createProject、DSL 校验 | 项目不是 TS，无编译期类型保障 |
| Frontend State | High | V2 store、seating planner、message handler | 未逐步模拟全部用户流 |
| Backend API | High | route registration、V2 routes、tools/manim/chat/solver routes | 未生成 OpenAPI 契约 |
| Dependency Weight | Medium | bundle size、vendor libs、package deps | 未跑 unused dependency 分析 |
| Code Consistency | Medium | V2 风格、旧 routes 风格、错误格式 | 未自动格式化 diff |
| Comment Coverage | Medium | V2 文件头注释、旧代码注释密度 | 未用工具计算注释率 |

## 3. Top Risks

1. High - Gateway 默认开放本地工具 API 且没有认证：如果服务被局域网、代理或误配置暴露，AI 调用、文件上传、Manim 作业管理和失败重放都可被直接访问。
2. Medium - Timetable V2 发布接口相信客户端声明：伪造或过期的 `solution` 可以绕过“零硬冲突”门禁。
3. Medium - Timetable V2 本地存储没有版本冲突控制：两个窗口同时保存会最后写入覆盖前一个结果。
4. Medium - 部分外部模型调用没有明确超时：上游卡住时会拖住请求和资源。
5. Medium - 反馈日志和截图没有保留期：学生/座位/截图类本地数据会无限累积。
6. Medium - 后端直接 import `public/js` 前端模块：UI 改动可能破坏后端算法。
7. Medium - seating/message 旧模块体积过大：小需求改动会跨越 UI、AI、算法、DOM 和导出逻辑。
8. Medium - 没有 CI/release gate：本地测试虽然好，但推送后没有自动守门。
9. Low - 500 错误把 `error.message` 直接回传：调试方便，但会泄露内部实现和上游错误。
10. Low - V2 表单 label 未显式绑定控件：对鼠标用户影响小，对键盘/读屏体验会降级。

## 4. Detailed Findings

### Finding: Gateway API 缺少应用级认证和本地绑定硬边界

- Severity: High
- Confidence: High
- Category: Security
- Status: Confirmed
- Affected area: Gateway HTTP server, Manim, AI, Solver, Tools APIs
- Evidence:
  - File: gateway/server.js:15-34
  - File: gateway/config/environment.js:17-27
  - File: gateway/middleware/core.js:10-33
  - File: gateway/routes/index.js:11-19
  - File: gateway/routes/manim.js:74-142
  - Function / Module: `startGateway`, `registerCoreMiddleware`, `registerApiRoutes`, `manimRoutes`
  - Relevant behavior: server uses `app.listen(config.port)` without explicit host binding, routes mount AI/tool APIs without authentication, Manim jobs/failures/replay/patch endpoints are public behind only CORS and rate limit.
- Problem: 当前网关把“本机使用”当作隐含安全边界，但代码没有把这个边界硬编码或配置化校验。CORS 不是认证；同机恶意页面、代理暴露、远程桌面环境、容器端口映射、局域网误开放，都可能绕过这个假设。
- Why it matters: 这些接口能触发外部 AI 成本、上传文件、查看作业状态、取消/重放 Manim 作业、提交 patch。对本地工具来说这不一定是线上级别灾难，但属于最应该先修的安全基本盘。
- Realistic failure scenario: 用户启动 `npm start` 后，某个开发代理或安全软件把 3000 端口暴露到局域网；同网段机器访问 `/api/manim/failures` 查看失败记录，再调用 `/api/manim/failures/:eventId/replay` 或 `/api/tools/seating/parse-image` 消耗本机资源和外部 API 配额。
- Minimal fix: 增加 `HOST` 配置，默认 `127.0.0.1`；远程访问必须显式设置 `ALLOW_REMOTE=true`。对 `/api/**` 增加本地 token 中间件，首次启动生成或要求配置 `ICECREAM_LOCAL_TOKEN`，前端同源请求带 header。
- Better long-term fix: 把普通 UI API、调试/管理 API、重放/patch API 分成不同路由组；管理类接口默认关闭，开启时要求 token、审计日志和更严格限流。
- Regression test suggestion: 构造 gateway app，断言未带 token 的 `/api/manim/failures` 返回 401；启动配置默认 host 为 `127.0.0.1`；设置 `ALLOW_REMOTE=true` 才允许非 loopback 绑定。
- Estimated effort: 0.5-1.5 days

### Finding: Timetable V2 发布接口信任客户端传入的冲突状态

- Severity: Medium
- Confidence: High
- Category: Stability
- Status: Confirmed
- Affected area: Timetable V2 publish API
- Evidence:
  - File: gateway/services/timetable-v2/api/routes.js:215-244
  - File: test/timetable-v2-api.test.js:131-154
  - Function / Module: `POST /api/tools/timetable-v2/schedule/publish`
  - Relevant behavior: publish reads `solution.hardConflicts` and `solution.unplaced`; arrays为空就返回 `published: true`，没有基于 `project` 和 `placements` 服务端重算硬冲突。
- Problem: 发布门禁使用的是客户端声明，而不是服务端可信计算结果。现有测试覆盖了“客户端传 unplaced/hardConflicts 时拒绝”，但没有覆盖“客户端把冲突字段伪造成空”的情况。
- Why it matters: 发布是排课系统的可信边界。只要这层不重算，任何过期前端状态、手动调整 bug、恶意请求或导入残留都可能发布一份实际有硬冲突的课表。
- Realistic failure scenario: A 窗口求解出一个解，B 窗口修改教师不可用规则；A 窗口仍提交旧 `solution`，并带空 `hardConflicts`。后端只看数组为空，于是发布通过。
- Minimal fix: publish 内部调用已有 V2 约束检测，对 `project + solution.placements` 重建 solution 并运行 `detectHardConflicts`，同时检查 `unplaced` 是否由服务端求解/诊断得出。
- Better long-term fix: 发布只接受 `projectVersion` 和 `solutionId`，服务端从自己的快照中取解；手动调整也先保存为服务端 draft，再发布 draft。
- Regression test suggestion: 在 API test 中提交一份同教师同时间的 placements，同时把 `hardConflicts: []` 和 `unplaced: []` 伪造成干净，期望 422。
- Estimated effort: 0.5-1 day

### Finding: Timetable V2 本地存储缺少乐观并发控制

- Severity: Medium
- Confidence: High
- Category: Stability
- Status: Confirmed
- Affected area: Timetable V2 project store
- Evidence:
  - File: gateway/services/timetable-v2/api/store.js:27-62
  - File: public/js/tools/timetable-v2/api/client.js:11-27
  - Function / Module: `createTimetableV2Store.saveProject`, V2 API client
  - Relevant behavior: store 用 tmp + rename 原子写入，但没有 revision、etag、expectedUpdatedAt 或 compare-and-swap；前端已有 `version_conflict` 文案，但后端没有产生该冲突。
- Problem: 原子写能防止半文件，但不能防止并发覆盖。两个浏览器窗口或两个 AI agent 同时保存时，后写会无提示覆盖先写。
- Why it matters: 排课数据属于长编辑数据，用户很可能打开多个窗口、或者 Claude/Codex 与用户同时改。无冲突检测会制造“我刚改的规则不见了”的低频高痛事故。
- Realistic failure scenario: 用户在数据准备页导入项目后，另一个窗口在规则页提交自然语言约束；第一个窗口又保存旧项目结构，第二个窗口的规则被覆盖，没有任何冲突提示。
- Minimal fix: 项目保存返回并持久化 `revision` 或 `updatedAt`；保存接口要求 `expectedRevision`，不匹配返回 409 和 `reason: version_conflict`。
- Better long-term fix: 对项目、规则草稿、解草稿分离存储；每个写入口有独立 revision 和审计记录。
- Regression test suggestion: 在 store/API test 中先 load 两份副本，保存第一份后再用旧 revision 保存第二份，期望 409，不覆盖文件。
- Estimated effort: 0.5-1 day

### Finding: 部分外部模型调用没有明确超时和重试预算

- Severity: Medium
- Confidence: High
- Category: Stability
- Status: Confirmed
- Affected area: OCR, solver vision fallback, external LLM calls
- Evidence:
  - File: gateway/services/ocr.js:323-335
  - File: services/solver/siliconflow.js:70-82
  - File: services/solver/siliconflow.js:127-140
  - File: services/solver/siliconflow.js:182-194
  - File: services/solver/siliconflow.js:242-252
  - Function / Module: `extractStudentsWithAI`, `detectWithFallbackAPI`, SiliconFlow vision functions
  - Relevant behavior: several `fetch(...)` calls do not pass `signal` or a shared timeout/retry budget.
- Problem: 项目里有些调用已经加了 `AbortSignal.timeout`，但不是统一策略。没有超时的外部调用在上游卡住时会把 HTTP 请求拖到运行时默认行为，表现为页面一直转、连接占用、用户重复点击。
- Why it matters: OCR/AI 是成本和稳定性的热点。一个卡住的 provider 不应该把本地网关拖住，也不应该让用户无明确反馈。
- Realistic failure scenario: SiliconFlow 或 DeepSeek TCP 连接建立后不返回 body；用户上传名单图片，网关请求悬挂，前端一直等待，用户重复上传，最终堆积多个未完成请求。
- Minimal fix: 建一个 `fetchJsonWithTimeout` 或 `callModelWithBudget` 工具，统一 `timeoutMs`、重试次数、错误归一化；所有外部模型调用必须传 `AbortSignal.timeout(...)`。
- Better long-term fix: 增加按功能的预算配置，例如 OCR 60s、VLM 120s、Manim 20min；配套 metrics 记录 timeout、retry、provider、cost class。
- Regression test suggestion: mock 一个永不 resolve 的 fetch，断言指定时间内返回用户可读错误，且不会重试超过预算。
- Estimated effort: 0.5-1 day

### Finding: 反馈日志和截图资产没有保留期与删除路径

- Severity: Medium
- Confidence: High
- Category: Security
- Status: Confirmed
- Affected area: Seating feedback, local logs, screenshot assets
- Evidence:
  - File: gateway/services/seating-feedback.js:146-162
  - File: gateway/services/seating-feedback.js:283-324
  - Function / Module: `submitSeatingFeedback`, `saveFeedbackScreenshotAsset`
  - Relevant behavior: feedback writes JSONL to `logs/seating-feedback.jsonl` and screenshots to `logs/seating-feedback-assets`; code has redaction and screenshot base64 separation, but no retention/deletion/rotation enforcement.
- Problem: 反馈内容、座位快照和截图可能包含学生姓名、身高、成绩、座位偏好等敏感教育数据。即使是本地项目，也应该有最小化、保留期和清理命令。
- Why it matters: 本地日志最容易被忘记，之后压缩项目、换电脑、同步备份时会把敏感数据一起带走。
- Realistic failure scenario: 教师连续几个月提交座位反馈，截图资产长期留在 `logs/`；后来把整个项目目录打包给别人排查问题，反馈中的学生信息被一并带出。
- Minimal fix: 增加 `FEEDBACK_RETENTION_DAYS`，启动时或提交后清理过期 JSONL 行和截图文件；提供 `npm run cleanup:feedback`。
- Better long-term fix: 默认不保存截图，改为用户主动勾选；反馈存储增加数据分类、导出、删除和审计元信息。
- Regression test suggestion: 创建过期 feedback asset 和 JSONL 行，运行 cleanup，断言过期数据删除、近期数据保留、`.gitkeep` 或目录结构不被误删。
- Estimated effort: 0.5 day

### Finding: 后端 seating 服务直接依赖 public 前端模块

- Severity: Medium
- Confidence: High
- Category: Maintainability
- Status: Confirmed
- Affected area: Seating backend/frontend boundary
- Evidence:
  - File: gateway/services/seating-arrange.js:1-13
  - Function / Module: `gateway/services/seating-arrange.js`
  - Relevant behavior: backend imports `../../public/js/tools/classroom-layout.js` and `../../public/js/tools/seating-core.js` directly。
- Problem: `public/js` 是浏览器交付层，`gateway/services` 是后端服务层。后端直接 import 前端目录会把依赖方向倒过来：前端文件重构、DOM 兼容、bundle 需求都可能影响后端。
- Why it matters: 这类边界破坏短期省代码，长期会让“改 UI”变成“可能改坏服务端排座算法”。这也是 seating 旧模块比 V2 难维护的根源之一。
- Realistic failure scenario: 为了前端打包把 `seating-core.js` 改成依赖 `window` 或 DOM helper，后端 `npm test` 开始失败，或者生产运行时 import 崩溃。
- Minimal fix: 把纯算法搬到 `shared/seating/` 或 `gateway/services/seating-domain/`，前端和后端都只 import 纯模块；`public/js` 只保留 DOM/UI 层。
- Better long-term fix: seating 像 timetable-v2 一样拆成 domain、constraints、solver、api、views 五层。
- Regression test suggestion: 增加 import graph 测试，禁止 `gateway/**` import `public/**`，允许白名单迁移期文件并设置到期日期。
- Estimated effort: 1-2 days

### Finding: 旧课堂工具箱存在多处巨石文件，改动半径过大

- Severity: Medium
- Confidence: High
- Category: Maintainability
- Status: Confirmed
- Affected area: Seating planner, message handler, tools route, GeoGebra studio
- Evidence:
  - File: public/js/tools/seating-planner.js:1-7352
  - File: gateway/services/seating-arrange.js:1-3056
  - File: public/js/core/geogebra-studio.js:1-2053
  - File: public/js/core/message-handler.js:1-1906
  - File: gateway/routes/tools.js:1-722
  - Function / Module: seating planner, message handler, tools routes
  - Relevant behavior: UI state、DOM、AI prompt、API 调用、fallback、导入导出逻辑集中在超大文件中。
- Problem: 文件过大本身不是罪，但这些文件同时承担多个职责。后续加功能时很难只改一个小模块，测试定位也会变慢。
- Why it matters: 你现在已经体会到了 Phase 2 难：不是算法一个点难，而是边界没拆清楚时，每个改动都像在拉一张打结的网。
- Realistic failure scenario: 修改 seating 聊天确认文案时，不小心影响 roster import 或 drag 行为；测试能抓一部分，但开发者理解成本持续上升。
- Minimal fix: 从最稳定的切口拆：`gateway/routes/tools.js` 只保留 HTTP glue；seating AI prompt、OCR import、export、feedback、chat 各自成为 route module。前端把 seating planner 拆出 roster、layout canvas、assistant、export、feedback 面板。
- Better long-term fix: 对 seating 做一次 V2 风格的重建，但保留 UI 体验元素；旧文件进入 compatibility shell。
- Regression test suggestion: 每拆一个模块，保留现有 476 测试，并新增 import-level contract test，确保 public API 不变。
- Estimated effort: 3-7 days

### Finding: 缺少 CI 和发布前自动门禁

- Severity: Medium
- Confidence: High
- Category: Release
- Status: Confirmed
- Affected area: Repository release workflow
- Evidence:
  - File: package.json:6-16
  - File: package.json:42-53
  - File: .github: directory missing
  - Function / Module: npm scripts and GitHub workflow
  - Relevant behavior: scripts include start/build/test, but no lint/type/audit/CI workflow；`.github` 目录不存在。
- Problem: 本地 `npm test` 很强，但推送到 GitHub 后没有自动重复这些门禁，也没有针对 Windows 环境、bundle 构建、V2 integration verify、dependency audit 的统一 release gate。
- Why it matters: 这个项目已经进入多工具、多语言、多 agent 协作状态。没有 CI，质量取决于“谁记得跑什么命令”，这迟早会漏。
- Realistic failure scenario: 某次提交只改前端 V2，忘记跑 `npm run build:timetable-v2`，提交了过期 bundle；本地能跑源码，用户拉取后加载的却是旧 bundle。
- Minimal fix: 新增 `.github/workflows/ci.yml`，运行 `npm ci`、`npm test`、`npm run build:timetable-v2`、`node test/timetable-v2-ui-verify.mjs`、`node test/timetable-v2-integration-verify.mjs`。
- Better long-term fix: 加 release preflight 脚本：依赖审计、bundle 大小阈值、OpenSpec 校验、Manim env check、solver build smoke。
- Regression test suggestion: CI 本身就是回归门禁；另加脚本测试确保 `dist/workbench.bundle.js` 与源码同步构建。
- Estimated effort: 0.5 day

### Finding: 多个路由把内部错误消息直接返回给客户端

- Severity: Low
- Confidence: High
- Category: Security
- Status: Confirmed
- Affected area: Gateway routes error handling
- Evidence:
  - File: gateway/routes/manim.js:74-142
  - File: gateway/routes/tools.js:358-386
  - File: gateway/routes/chat.js:15-26
  - File: gateway/routes/solver.js:16-27
  - Function / Module: route catch blocks
  - Relevant behavior: catch blocks often return `{ success:false, error:error.message }` with status 500.
- Problem: 直接返回内部 `error.message` 对本地调试很方便，但它把上游 provider 信息、内部路径、异常细节和实现名称暴露给前端。现在项目还混合不同错误格式，前端也要猜 reason。
- Why it matters: 当 API 开始加认证、远程访问或共享部署时，错误泄露会放大安全和用户体验问题。
- Realistic failure scenario: 上游 SDK 抛出包含内部 base URL、模型名或请求细节的错误；前端 toast 直接展示，用户截图反馈时把内部信息带出。
- Minimal fix: 中央错误映射：5xx 返回通用中文消息和 `requestId`，日志记录完整错误；4xx 才返回可控业务 reason。
- Better long-term fix: 为所有 API 建统一 envelope：`success/data/error/reason/requestId/details`，其中 details 只在 dev 模式返回。
- Regression test suggestion: mock 一个包含内部 URL 的错误，断言 production response 不包含内部字符串，日志仍保留。
- Estimated effort: 0.5-1 day

### Finding: V2 表单 label 没有显式绑定控件

- Severity: Low
- Confidence: High
- Category: Maintainability
- Status: Confirmed
- Affected area: Timetable V2 rule input UI
- Evidence:
  - File: public/js/tools/timetable-v2/views/rule-input.js:223-230
  - File: public/js/tools/timetable-v2/components/step-nav.js:68-103
  - Function / Module: `labeledField`, `createStepNav`
  - Relevant behavior: `labeledField` creates a label and appends the control, but does not assign `id`/`htmlFor`; step nav already has `aria-label` and `aria-current`, so this is a targeted form-label issue rather than global a11y failure.
- Problem: label 和控件视觉上靠在一起，但对部分读屏器、自动化测试和点击 label 聚焦行为来说，不如显式 `for`/`id` 稳定。
- Why it matters: 排课工具会被教师反复使用，表单体验细节影响输入效率，也影响后续做自动无障碍测试。
- Realistic failure scenario: 用户点击“自然语言约束”文字期望聚焦 textarea，但浏览器/辅助技术没有稳定关联；自动化 a11y 扫描报 label 关联缺失。
- Minimal fix: `labeledField` 如果 control 无 id，则生成稳定 id；设置 `label.htmlFor = control.id`。
- Better long-term fix: 给 V2 UI 建一组基础表单组件，统一 label、error、help、aria-describedby。
- Regression test suggestion: DOM test 断言所有 `.ttv2-view__field label` 都有 `for`，并指向存在的 input/textarea/select。
- Estimated effort: 30 minutes

## 5. Architecture Concerns / Architecture Analysis

- Coverage: High
- Inspected evidence: `gateway/services/timetable-v2/**`, `gateway/routes/index.js`, `gateway/services/seating-arrange.js`, `public/js/tools/seating-planner.js`, OpenSpec archived specs
- Exclusions / limits: 未逐行审完 Manim Python 服务；本节重点是 Node gateway 和课堂工具箱。

V2 排课的架构方向是对的：后端核心围绕 Activity、Project、Constraint、Solution、Diagnostics 拆开，API routes 只做 glue，前端 V2 也有 `api/state/views/components` 的基本分层。`test/timetable-v2-api.test.js:218-226` 还专门断言 routes 不包含排课/诊断算法实现，这是很好的架构守门。

旧 seating 仍然是主要架构债务。`gateway/services/seating-arrange.js` 直接 import `public/js/tools`，说明纯业务逻辑没有独立边界。`public/js/tools/seating-planner.js` 7352 行，已经超过“靠命名和注释能掌控”的范围。建议不要马上推倒 seating，而是按 V2 的模式逐步抽 domain 和 route modules。

### Architecture Summary

| Subtype | Count | Affected Areas | Recommended Action |
|---------|-------|----------------|-------------------|
| ModuleBoundary | 2 | seating backend/public imports, tools route | 拆 shared/domain 层 |
| DependencyDirection | 1 | `gateway/services/seating-arrange.js` | 禁止 backend import public |
| StateOwnership | 2 | V2 publish, V2 store | 服务端持有 publish/revision 真相 |
| BoundaryContract | 2 | API error envelope, publish contract | 增加 schema/version/reason |
| EvolutionRisk | 3 | seating planner, message handler, tools route | 分模块迁移 |

## 6. Security Concerns

- Coverage: High
- Inspected evidence: `gateway/server.js`, `gateway/middleware/core.js`, `gateway/security.js`, `gateway/routes/manim.js`, `gateway/routes/tools.js`, sanitizer files
- Exclusions / limits: 未做黑盒渗透；只做源码级安全审查。

最大的安全问题是认证和监听边界，不是 XSS。Markdown 渲染路径有 `sanitizeHtml`，`public/js/utils/markdown.js:68-70` 在返回 HTML 前清洗，`public/js/utils/sanitize.js:1-112` 限制标签、属性和 URL，这是加分项。真正要先修的是 API 层：Manim job/failure/replay/patch、AI/OCR/solver 都应被 token 或 local-only policy 保护。

## 7. Stability Concerns

- Coverage: High
- Inspected evidence: V2 store/publish、外部 fetch、测试输出、fallback 分支
- Exclusions / limits: 未跑长时间 soak test。

V2 求解器稳定性不错：benchmark 能在约 43ms 处理 810 activities 且 0 hard conflicts，测试覆盖了不可解项目、seed 可复现、教室冲突、连堂、固定课等。稳定性短板在边界：发布不重算、存储不 CAS、部分 fetch 无 timeout。

## 8. Performance Concerns

- Coverage: Medium
- Inspected evidence: `npm test` benchmark、`build:timetable-v2` bundle 输出、行数统计
- Exclusions / limits: 未跑浏览器性能 profile。

V2 核心性能目前很好，不是瓶颈。需要关注的是前端 bundle 和旧 UI 巨石：`build:timetable-v2` 输出 2.1MB，里面包含 React/Konva 等依赖；旧 seating planner 文件过大，未来渲染和状态更新容易出现局部性能退化。建议先设 bundle size warning，不要急着优化算法。

## 9. Testing Gaps

- Coverage: High
- Inspected evidence: `npm test` 476/476、V2 API/domain/solver/importer/diagnostics/NL tests、UI verify files
- Exclusions / limits: 未做 mutation testing 和真实浏览器 a11y scan。

测试是当前项目最亮的地方之一。缺口不是“没有测试”，而是缺并发、恶意输入、发布伪造、认证拒绝、CI 环境重复执行。最应该补的四个测试：伪造 clean solution 发布失败、旧 revision 保存返回 409、无 token 访问 Manim 管理接口返回 401、外部 fetch 超时返回可读错误。

## 10. Maintainability Concerns

- Coverage: High
- Inspected evidence: 行数统计、route/service/view 分层、V2 与旧工具对比
- Exclusions / limits: 未跑圈复杂度工具。

V2 的维护性明显优于旧工具箱。旧 seating/message/tools route 仍然是维护性压力源。建议把重构精力优先给旧模块的边界，而不是继续在巨石文件里堆功能。

## 11. Design / Principles Concerns

- Coverage: High
- Inspected evidence: V2 design、dependency direction、API contracts
- Exclusions / limits: 未做完整 DDD 建模复盘。

V2 遵守了“核心模型独立、接口薄、测试驱动”的设计原则。违反比较明显的是旧 seating 的依赖方向和网关边界的 fail-fast 不足：缺 API key 只 warning，远程暴露没有 fail-fast，发布门禁不重算。

## 12. Type Safety Concerns

- Coverage: Medium
- Inspected evidence: JS validation、`createProject`、DSL validation、API request handling
- Exclusions / limits: 项目不是 TypeScript，未做类型迁移评估。

项目靠运行时校验维持类型安全。V2 的 `createProject`、DSL registry、importer report 做得不错。风险集中在 API 入参和客户端 solution 结构：JS 没有编译期保护，所以关键边界必须强校验，尤其 publish 和 save。

## 13. Release Concerns

- Coverage: Medium
- Inspected evidence: `package.json`, `.github` missing, build/test commands
- Exclusions / limits: 未检查远端 GitHub branch protection。

现在 release 主要靠人工记忆。`npm test` 和 `npm run build:timetable-v2` 都能跑通，但没有 GitHub Actions，没有 branch protection 证据，没有 bundle 同步门禁。这个缺口很容易让“本地过了”变成“远端坏了”。

## 14. Documentation Analysis

- Coverage: Medium
- Inspected evidence: `OpenSpec/project.md`, `OpenSpec/roadmap.md`, `OpenSpec/specs/**`, archived changes
- Exclusions / limits: README 未做逐段事实核验。

OpenSpec 流程比一般个人项目强，V2 相关 specs 已归档，说明需求/设计/任务不是凭空写代码。缺的是运行手册和安全说明：哪些接口是本地-only、如何启用远程访问、如何清理反馈数据、如何发布/回滚、如何处理 `.env` 和 token。

### Documentation Summary

| Subtype | Count | Affected Docs | Recommended Action |
|---------|-------|---------------|-------------------|
| OperatorDocs | 3 | README, roadmap, missing runbook | 增加启动/端口/安全/清理说明 |
| DeveloperDocs | 2 | package scripts, CI docs | 写明 test/build/preflight |
| ApiDocs | 2 | V2 publish/save contracts | 记录 revision 和发布重算规则 |
| DecisionRecord | 1 | timetable V2 architecture | 补 ADR：为何 Activity-centric |
| StaleDocs | 0 | none confirmed | 暂无确证 |

## 15. Observability / Operability Analysis

- Coverage: Medium
- Inspected evidence: request logger、health route、feedback logs、route error patterns
- Exclusions / limits: 未接入真实 metrics/tracing。

项目有 console 日志、health route、反馈日志，但缺少统一 requestId/correlationId、结构化错误、外部 provider timeout metrics。对于本地工具不必上 Prometheus，但至少要让用户/开发者知道是哪次请求、哪个 provider、失败原因属于 timeout、quota、validation 还是 upstream。

### Signal Summary

| Subtype | Count | Critical Signals Missing | Recommended Action |
|---------|-------|--------------------------|-------------------|
| Logging | 2 | requestId, provider error class | 加结构化日志 |
| Metrics | 2 | AI/OCR timeout count, publish rejection count | 简单 counters 即可 |
| Tracing | 1 | request correlation | response 带 requestId |
| HealthCheck | 1 | dependency readiness | health 区分 gateway 和 provider |
| Runbook | 1 | Manim/AI 故障处理 | 写本地 runbook |

## 16. Configuration Safety Analysis

- Coverage: High
- Inspected evidence: `gateway/config/environment.js`, `gateway/server.js`, package scripts
- Exclusions / limits: 未审用户本机 `.env`。

配置现在偏宽松：缺关键 AI 配置只 warning，不 fail-fast；网关缺 `HOST`；功能性 body limit、rate limit 有默认值但没有统一 schema。建议增加配置 schema 和启动摘要，把“安全默认”写进代码。

### Configuration Summary

| Subtype | Count | Affected Keys / Files | Recommended Action |
|---------|-------|-----------------------|-------------------|
| SchemaValidation | 1 | `environment.js` | 集中校验类型和范围 |
| UnsafeDefault | 1 | gateway host | 默认 loopback |
| EnvironmentSeparation | 1 | dev/prod error details | production 隐藏内部错误 |
| SecretConfig | 1 | AI provider keys | 不在响应中泄露 provider 信息 |
| ConfigDocs | 1 | README/runbook | 补配置表 |

## 17. Data Integrity Analysis

- Coverage: High
- Inspected evidence: V2 store, publish, importers, export
- Exclusions / limits: 未做备份恢复演练。

V2 importers 的报告机制和不 mutate 入参测试是亮点。数据完整性风险集中在发布可信边界和并发保存。原子写是必要但不充分，publish 返回 `published: true` 也不等于持久发布历史已经落库。

### Integrity Summary

| Subtype | Count | Invariants at Risk | Recommended Action |
|---------|-------|-------------------|-------------------|
| TransactionBoundary | 1 | publish snapshot | 服务端持久化发布快照 |
| ConcurrencyConsistency | 1 | project save | revision/CAS |
| InvariantValidation | 1 | hard conflict free publish | 发布前重算 |
| BackupRestore | 1 | local JSON data | 写恢复说明和测试 |

## 18. Privacy / Data Governance Analysis

- Coverage: Medium
- Inspected evidence: seating feedback, logs, uploads cleanup
- Exclusions / limits: 未读取用户真实 logs 内容。

反馈系统已经有匿名化和截图 base64 不进 JSONL 的意识，这是好事。缺的是数据生命周期：保留多久、怎么删、截图默认是否保存、导出项目时如何避免打包日志。

### Privacy Summary

| Subtype | Count | Affected Data | Recommended Action |
|---------|-------|---------------|-------------------|
| DataInventory | 1 | feedback, screenshots, project JSON | 写数据清单 |
| Minimization | 1 | feedback screenshots | 默认不保存或缩短保存 |
| Retention | 1 | `logs/seating-feedback*` | 加保留期 |
| Deletion | 1 | local logs/assets | 加 cleanup 命令 |
| TelemetryPrivacy | 1 | error logs | 统一 redact |

## 19. Accessibility / UX Correctness Analysis

- Coverage: Medium
- Inspected evidence: V2 rule input, step nav, UI verify
- Exclusions / limits: 未跑 axe/playwright a11y。

V2 不是完全忽视无障碍：step nav 有 `aria-label` 和 `aria-current`。主要缺口是表单 label 显式关联、错误状态 aria、键盘焦点回归。建议把这些作为小修，不需要大改 UI。

### Accessibility Summary

| Subtype | Count | Affected Workflows | Recommended Action |
|---------|-------|-------------------|-------------------|
| SemanticStructure | 1 | rule input | label for/id |
| KeyboardFocus | 1 | publish/solve loading | 操作后焦点管理 |
| ErrorState | 1 | API errors | aria-describedby |
| UXStateCorrectness | 1 | publish dirty state | 与服务端 publish snapshot 对齐 |

## 20. Supply Chain / Reproducibility Analysis

- Coverage: Medium
- Inspected evidence: `package-lock.json`, `manim-service/requirements.txt`, committed vendor/bundle
- Exclusions / limits: 未跑漏洞扫描。

项目有 `package-lock.json`，这是可复现基础。风险是没有 CI 固定 Node/Python 版本，没有 vendor/provenance 清单，V2 bundle 被提交但缺同步校验。离线工具可以保留 vendor，但要记录来源、版本、校验和。

### Supply Chain Summary

| Subtype | Count | Affected Surface | Recommended Action |
|---------|-------|------------------|-------------------|
| DependencyProvenance | 1 | `public/vendor`, `public/js/libs` | 写 vendor manifest |
| Reproducibility | 1 | Node/Python toolchain | CI pin versions |
| ArtifactProvenance | 1 | V2 dist bundle | 构建校验 |
| RegistryHygiene | 1 | npm deps | 定期 audit |

## 21. Cost / Resource Economics Analysis

- Coverage: Medium
- Inspected evidence: rate limit middleware, AI/OCR/Manim routes, external fetch
- Exclusions / limits: 未拿真实账单。

成本风险来自 AI/OCR/Manim。限流已存在，但没有认证时限流只能减速不能授权；没有统一 timeout 时成本/资源不可控。建议每个外部 provider 都有 timeout、并发、token/图片大小预算和失败分类。

### Cost Summary

| Subtype | Count | Cost Driver | Recommended Action |
|---------|-------|-------------|-------------------|
| ExternalApiCost | 2 | DeepSeek, SiliconFlow | timeout + quota + auth |
| LLMCost | 1 | chat/solver/manim prompts | token budget |
| UnboundedWork | 1 | Manim replay/render | 管理接口认证 |
| ObservabilityCost | 1 | feedback/log growth | retention |

## 22. AI / LLM Safety Analysis

- Coverage: Medium
- Inspected evidence: V2 NL parser, seating AI routes, solver/chat routes, sanitizer
- Exclusions / limits: 未做 prompt injection 专项测试。

V2 自然语言规则解析是 deterministic parser，安全性比直接让 LLM 改项目强。旧 seating 和 GeoGebra/Manim 仍大量依赖 AI JSON 输出，但很多地方有 JSON parse、fallback、validation。下一步要补的是工具授权：AI 输出不能直接拥有发布、重放、patch 这类能力。

### AI Safety Summary

| Subtype | Count | Boundary Crossed | Recommended Action |
|---------|-------|------------------|-------------------|
| ToolAuthorization | 1 | Manim patch/replay | token + explicit user action |
| OutputValidation | 1 | seating AI JSON | 保持 schema validation |
| AbuseCost | 1 | public AI endpoints | auth + quota |
| EvalGap | 1 | prompt injection | 增加恶意输入样本 |

## 23. Fallback / Defensive Code Analysis

- Coverage: Medium
- Inspected evidence: OCR fallback, Manim fallback, V2 unsupported NL rules, catch blocks
- Exclusions / limits: 未审所有 fallback。

项目的 fallback 多，但质量参差。好的 fallback 会返回结构化 reason，比如 V2 unsupported 规则、不可解项目 reason。差的 fallback 是 catch 后直接 `error.message` 或悄悄吞掉截图保存失败。建议给 fallback 分类：用户可恢复、系统降级、必须报警、必须失败。

### Fallback Summary

| Subtype | Count | KeepWithAlert | FailFast | Remove |
|---------|-------|---------------|----------|--------|
| SilentFallback | 1 | 1 | 0 | 0 |
| EmptyCatch | 1 | 0 | 1 | 0 |
| CompatibilityBranch | 2 | 2 | 0 | 0 |
| SilentCorrection | 1 | 1 | 0 | 0 |
| DefensiveGuess | 1 | 0 | 1 | 0 |

## 24. Testing Authenticity Analysis

- Coverage: High
- Inspected evidence: 476 passing tests, V2 API/domain/solver/importer tests, UI/integration verify files
- Exclusions / limits: 未做 mutation testing。

这些测试不是摆设。V2 solver tests 覆盖了硬约束、性能、seed、教室、不可解；importer tests 覆盖不 mutate、报告一致性、旧数据迁移；API tests 覆盖路由薄层。可疑区域是 UI verify 使用 mock sample，真实浏览器覆盖还不够。

### Confidence Assessment

| Test Area | Real Confidence | Risk | Action |
|-----------|---------------|------|--------|
| V2 solver/domain | High | 复杂真实学校数据差异 | Keep |
| V2 importers | High | 特殊 Excel/水晶字段 | Keep and add fixtures |
| V2 API | Medium | publish 伪造和并发未测 | Add tests |
| V2 UI verify | Medium | mock 多，真实浏览器少 | Add Playwright smoke |
| Old seating | Medium | 覆盖广但模块太大 | Keep while refactoring |

### Valuable Tests

V2 solver benchmark、importer 不 mutate、发布门禁基础测试、sanitizeHtml、upload whitelist、Gateway route mounting 都是真正有回归价值的测试。

### Suspicious Tests

UI verify 里基于 mock sample 的测试只能证明组件能装起来，不证明真实 API 数据和浏览器交互全链路稳定。它应该保留，但不能当作唯一 UI 信心来源。

### Missing Tests

发布伪造、并发保存、认证拒绝、外部 fetch timeout、feedback retention、bundle 源码同步。

## 25. Type Safety Analysis

- Coverage: Medium
- Inspected evidence: V2 validation、DSL registry、JS API envelopes
- Exclusions / limits: 未迁移 TypeScript。

不用 TypeScript 不是原罪，但关键边界必须更硬。V2 的运行时校验已经承担了“类型系统”的一部分职责。下一步优先给 API payload 写 JSON schema 或 zod-like validator，而不是全项目 TS 化。

### Summary

| Subtype | Count | Critical | High | Medium | Low |
|---------|-------|----------|------|--------|-----|
| InputBoundary | 3 | 0 | 0 | 2 | 1 |
| OutputLeak | 1 | 0 | 0 | 0 | 1 |
| StringlyTyped | 2 | 0 | 0 | 1 | 1 |
| ErrorType | 1 | 0 | 0 | 0 | 1 |

## 26. Frontend State Analysis

- Coverage: High
- Inspected evidence: V2 state/store/views, seating planner, message handler
- Exclusions / limits: 未逐步模拟所有点击流。

V2 前端状态比旧工具好很多。旧 `seating-planner.js` 和 `message-handler.js` 仍然混合 DOM、请求、业务、状态。发布状态目前是前端局部变量推导，未来应从服务端 publish snapshot/revision 推导。

### Summary

| Subtype | Count | Affected Components |
|---------|-------|-------------------|
| ComponentSize | 2 | seating planner, message handler |
| StateDuplication | 1 | publish dirty/published local state |
| UIBusinessCoupling | 2 | seating planner, message handler |
| RequestState | 1 | V2 request no abort/concurrency guard |
| DOMasState | 1 | old seating UI |

## 27. Backend API Analysis

- Coverage: High
- Inspected evidence: routes, V2 API, tools/manim/chat/solver
- Exclusions / limits: 未生成 OpenAPI。

API 主要问题是三件事：认证缺失、错误格式不统一、关键业务边界缺服务端重算。V2 routes 比旧 routes 清爽，但 publish 逻辑必须补强。

### Summary

| Subtype | Count | Affected Endpoints |
|---------|-------|-------------------|
| ApiConsistency | 1 | chat/solver/manim/tools/timetable-v2 |
| Validation | 1 | V2 publish |
| Auth | 1 | `/api/**` |
| ErrorResponse | 1 | 500 catch blocks |
| BusinessLogic | 1 | publish door |
| DataFlow | 1 | project save revision |

## 28. Dependency Weight Analysis

- Coverage: Medium
- Inspected evidence: `package.json`, build output, vendor/bundle paths
- Exclusions / limits: 未跑 depcheck。

V2 bundle 2.1MB 对本地工具可以接受，但需要阈值守门。`public/vendor/geogebra` 和 `public/js/libs` 是合理的离线取舍，但需要 manifest。`multer` 和 `nodemailer` 用途明确，不能简单删。

### Dependency Scoreboard

| Dependency | Status | Weight | Transitives | Used For | Recommended Action |
|------------|--------|--------|-------------|----------|-------------------|
| react/react-dom/react-konva | Healthy | bundle 2.1MB total | npm lock | V2 grid/UI | Keep, add size gate |
| public vendor libs | Needs provenance | large local assets | none tracked here | offline GeoGebra/libs | Keep with manifest |
| multer | Healthy | normal | npm lock | uploads | Keep |
| nodemailer | Healthy | normal | npm lock | feedback email | Keep |

## 29. Code Consistency Analysis

- Coverage: Medium
- Inspected evidence: V2 style, old routes, error handling
- Exclusions / limits: 未跑 formatter。

V2 文件头、函数职责和测试命名比较一致。旧工具代码风格不统一，例如 `gateway/routes/tools.js:372` 有压成一行的 JSON response，catch 里既有中文错误又有直接上游错误。建议在 CI 里加 formatter/lint，但不要让格式化大 diff 和功能改动混在一起。

## 30. Comment Coverage Analysis

- Coverage: Medium
- Inspected evidence: V2 modules, gateway routes, old seating files
- Exclusions / limits: 未自动统计注释率。

V2 注释大多解释“为什么这么分层”，质量不错。旧文件有不少注释解释功能，但巨石文件里注释会变成地图而不是边界。建议把注释重点放在复杂约束、迁移降级、fallback 条件上；普通 DOM 操作不需要继续加注释。

## 31. Principles Compliance

整体原则执行情况是“V2 好，旧模块欠账，网关边界要硬起来”。

### Principles Violated

| Principle | Violations | Severity | Affected Areas |
|-----------|------------|----------|----------------|
| Single Responsibility (SRP) | 4 | Medium | seating planner, seating arrange, message handler, tools route |
| Dependency Direction | 1 | Medium | backend imports public frontend modules |
| Fail-Fast | 3 | High | gateway host/auth, publish validation, config validation |
| Source of Truth | 2 | Medium | publish state, project revision |
| Error Boundary | 1 | Low | route catch blocks |
| File Size Limit | 4 | Medium | seating/message/geogebra/tools |

### Principles Respected

V2 尊重了分层、运行时校验、可复现求解、导入不 mutate、诊断可解释、测试先行。Markdown 渲染有 sanitizer，上传有白名单，V2 routes 有“薄路由”断言，这些都应该保留并扩展到旧工具。

## 32. Recommended Fix Order

### Fix Immediately

1. Gateway 默认绑定 `127.0.0.1`，增加 `/api/**` token。
2. V2 publish 服务端重算 hard conflicts 和 unplaced。
3. V2 save 增加 revision/CAS，返回 409 `version_conflict`。

### Fix Before Stable Release

1. 给所有外部模型调用加统一 timeout/retry budget。
2. 加 GitHub Actions：`npm ci`、`npm test`、`npm run build:timetable-v2`、V2 verify。
3. 反馈日志和截图加保留期/清理命令。
4. 统一 API error envelope 和 requestId。

### Schedule Later

1. seating 后端纯算法迁到 shared/domain。
2. 拆 `seating-planner.js`、`message-handler.js`、`gateway/routes/tools.js`。
3. vendor manifest、bundle size gate、dependency audit。
4. a11y 基础组件和 Playwright smoke。

### Ignore for Now

1. 不建议立刻把全项目迁到 TypeScript。
2. 不建议现在重写 V2 求解器。
3. 不建议删除 vendor/offline assets，先做来源和体积治理。

## 33. Quick Wins

1. `labeledField` 自动生成 id 并设置 `label.htmlFor`，30 分钟内能修。
2. 新增 publish 伪造冲突测试，先红后绿，半天内能把最大数据正确性洞补掉。
3. 新增 `HOST=127.0.0.1` 默认值和启动日志显示绑定地址，半天内能降低暴露风险。
4. 新增 `.github/workflows/ci.yml` 跑现有命令，半天内让远端提交有门禁。
5. 给 `extractStudentsWithAI` 和 `services/solver/siliconflow.js` fetch 加 `AbortSignal.timeout`，半天内能减少卡死。

## 34. Long-term Refactor Plan

1. Timetable V2 hardening

   Motivation: V2 核心已经可用，短板在可信边界。
   Approach: 先补 publish 重算、revision/CAS、publish snapshot，再补 API schema 和 OpenAPI 文档。
   Risk: 会触及前后端协议，需要同步改 mock/sample。
   Testing strategy: API tests + integration verify + forged solution/concurrent save tests。

2. Gateway security profile

   Motivation: 项目从本地实验工具成长为多 AI 工具箱，不能再只靠 CORS 和“我不会暴露端口”。
   Approach: local-only default、API token、管理路由隔离、requestId、production error mapper。
   Risk: 前端请求要统一带 token，开发体验可能多一步。
   Testing strategy: auth middleware tests + existing 476 tests 保持通过。

3. Seating domain extraction

   Motivation: seating 是旧债最大模块，但功能有价值，不该直接删。
   Approach: 先抽纯算法 shared/domain，再拆 route modules，最后拆前端面板。
   Risk: 文件拆分大，容易引入 import 回归。
   Testing strategy: 每一步只移动不改行为，跑全量 seating tests；增加 import graph guard。

4. Release and operations baseline

   Motivation: 多 agent 协作下，本地测试记忆不可靠。
   Approach: CI、preflight、bundle sync check、feedback cleanup、runbook。
   Risk: CI 初期会暴露环境依赖问题。
   Testing strategy: GitHub Actions 必须在 PR/Push 上跑通，失败即阻止合并。
