# 模块清单

每个模块的职责边界、接口契约和修改指南。**AI agent 修改代码前必读对应模块卡片。**

---

## 模块卡片格式说明

- **职责**：这个模块负责什么
- **不负责**：明确的边界（防止职责蔓延）
- **对外接口**：其他模块可以调用的稳定 API
- **内部实现**：可以自由重构的部分
- **依赖**：这个模块依赖谁（必须单向）
- **测试**：如何验证没改坏
- **常见改动**：典型场景的操作指引

---

## Gateway 核心

### gateway/server.js + gateway/app.js
- **职责**：server.js 负责启动与优雅关闭；app.js 负责 Express 应用组装（中间件注册、路由挂载、静态文件服务）
- **不负责**：业务逻辑、路由处理细节
- **对外接口**：`npm start` 启动入口；配置读取集中在 config/environment.js
- **依赖**：routes/index.js, middleware/, config/
- **测试**：`node --check gateway/server.js` + 启动冒烟
- **常见改动**：
  - 新增全局中间件 → middleware/ 建文件，在 app.js（或 middleware/core.js）注册
  - 新增顶层路由前缀 → routes/index.js 挂载
  - 新增工具子路由 → routes/tools.js 挂载

### gateway/middleware/intent-router.js
- **职责**：聊天消息意图分类（chat/manim/solver），分发到对应 handler
- **不负责**：具体业务处理
- **对外接口**：`routeIntent(message, context)` 
- **依赖**：services/intent-classifier.js, services/ (动态 import)
- **测试**：test/gateway-modules.test.js
- **常见改动**：
  - 新增意图类型 → 修改 intent-classifier.js 的分类逻辑 + intent-router.js 的分发分支

### gateway/security.js
- **职责**：上传文件过滤、文件名清洗、路径安全
- **对外接口**：`imageUploadFilter`, `sanitizeUploadFilename`
- **测试**：test/robustness-hardening.test.js
- **禁止**：任何绕过此模块直接处理用户上传的行为

---

## Seating 模块（座位安排）

### 后端服务层

#### gateway/services/seating-arrange.js（核心编排）
- **职责**：排座主流程编排（AI 布局 → 本地分配 → Solver 优化 → 校验）
- **不负责**：约束解析细节（callee: seating-constraints.js）、名单解析（callee: seating-roster.js）
- **对外接口**：
  - `runAiDrivenArrangement({request, fetchImpl, env})` - 完整排座
  - `runAiLayoutPreview({request, fetchImpl, env})` - 仅布局预览
  - `normalizeArrangeRequest(body)` - 请求规范化
- **内部实现**：本文件只保留顶层编排；`seating-arrange-spec.js` 负责规格，`seating-arrange-layout.js` 负责布局，`seating-arrange-assignment.js` 负责学生分配与优化，`seating-arrange-shared.js` 承载跨职责纯工具
- **依赖**：seating-constraints.js, seating-solver-bridge.js, shared/seating/
- **测试**：test/seating-arrange.test.js, test/seating-arrange-route.test.js
- **常见改动**：
  - 调整排座策略 → 修改内部算法函数（assignLocalSeats 等）
  - 新增布局参数 → normalizeArrangementSpec + AI prompt 同步更新

#### gateway/services/seating-constraints.js
- **职责**：自然语言约束 → 结构化 JSON（前排/同桌/不相邻等）
- **对外接口**：`parseSeatingConstraints({text, students, fetchImpl, env})`
- **测试**：test/seating-constraints-parser.test.js
- **常见改动**：
  - 新增约束类型 → DIRECT_TYPES 集合 + 解析规则 + solver 对应支持

#### gateway/services/seating-roster.js
- **职责**：学生名单解析（文本/CSV/XLSX/OCR 文本）
- **对外接口**：`parseStudentsText`, `parseRosterFile`, `normalizeSeatingStudents`, `mergeStudentDetails`, `buildImageImportReview`
- **测试**：test/seating-roster.test.js
- **常见改动**：
  - 支持新名单格式 → 新增解析分支，保持输出 schema 不变

#### gateway/services/seating-solver-bridge.js
- **职责**：调用 Timefold seating solver HTTP API，转换请求/响应格式
- **对外接口**：`solveWithTimefold({request, layout, spec, guardians, env, fetchImpl})`
- **错误契约**：solver 不可用时抛 `TimefoldUnavailableError`，调用方降级本地算法
- **测试**：test/seating-solver-bridge.test.js
- **常见改动**：
  - Solver API 变更 → 同步修改此文件 + Java 端 SeatingSolverResource

#### 其他 seating 服务
| 文件 | 职责 | 测试 |
|------|------|------|
| seating-chat.js | 排座对话式调整 | test/seating-chat.test.js |
| seating-layout.js | 布局矩阵操作工具 | test/seating-layout-route.test.js |
| seating-export.js | XLSX 导出 | test/seating-export-xlsx.test.js |
| seating-feedback.js | 用户反馈收集 | test/seating-feedback.test.js |
| seating-suggestions.js | 排座建议生成 | test/seating-suggestions.test.js |
| seating-diagnostics.js | 排座质量诊断 | - |

### 前端

#### public/js/tools/seating-planner.js + seating-planner/
- **职责**：座位安排完整 UI（名单导入、布局预览、网格编辑、导出）
- **结构**：seating-planner.js 为入口，seating-planner/ 下按面板拆分
  - roster-panel.js - 名单管理
  - grid-panel.js - 座位网格
  - assistant-panel.js - AI 对话
  - export-panel.js - 导出
  - layout-preview-panel.js - 布局预览
  - seat-detail-panel.js - 座位详情
  - feedback-panel.js - 反馈
  - api-client.js - 后端 API 封装
- **加载方式**：app-launcher.js 动态 import
- **测试**：test/seating-planner-ui.test.js
- **常见改动**：
  - 新增面板 → 新建 panel 文件 + 在 seating-planner.js 注册
  - API 调用变更 → 只改 api-client.js

### 共享逻辑

#### shared/seating/
- **职责**：前后端共用的座位核心逻辑（网格计算、布局验证）
- **文件**：seating-core.js, classroom-layout.js
- **引用方式**：
  - 后端：直接 import
  - 前端：通过 public/js/tools/seating-core.js 转发（`export * from '../../../shared/...'`）
- **约束**：不得引入 Node 或浏览器特有 API

### 求解器

#### solver/src/main/java/com/icecream/seating/
- **职责**：座位约束优化（Timefold）
- **关键类**：
  - domain/SeatingSolution.java - 规划实体
  - solver/SeatingConstraintProvider.java - 约束定义
  - rest/SeatingSolverResource.java - HTTP 端点
- **测试**：`npm run solver:test`（SeatingConstraintProviderTest 等）
- **常见改动**：
  - 新增约束 → SeatingConstraintProvider 添加 Constraint + 测试

---

## Timetable 模块（排课）

### 数据层

#### gateway/services/timetable-store.js
- **职责**：项目数据持久化（读写 data/timetable/projects.json）
- **对外接口**：
  - `createTimetableStore(options?)` - 创建 store 实例
  - `timetableStore` - 默认单例，提供 `loadProject()`, `saveProject(project)`, `loadProjects()` 等方法
- **禁止**：其他模块直接读写 projects.json 文件

#### gateway/services/timetable-project.js
- **职责**：项目数据结构规范化（字段清洗、ID 生成、枚举标准化）、各类 normalize 工具函数
- **关键导出**：`normalizeTimetableProject`, `normalizeSchedule`, `validateDutyAssignments`, `normalizeDutyAssignments` 以及大量 `normalize*` 辅助函数
- **测试**：test/timetable-project-normalization.test.js
- **重要**：项目 Schema 变更属 L2 级改动，需评估浏览器缓存快照兼容性

#### gateway/services/timetable-import.js
- **职责**：Excel/文本任课数据导入解析
- **关键导出**：`parseTimetableRosterText`, `previewTimetableRosterRows`, `buildRosterImportReport`, `buildTimetableRosterFromRows`
- **测试**：test/timetable-roster-workbook.test.js

### 约束子系统 (timetable-constraints/)

**架构**：自然语言 → 语义解析 → IR（中间表示）→ Solver 参数

| 文件 | 职责 |
|------|------|
| constraint-ir.js | IR 定义与规范化（约束的标准数据结构） |
| capabilities.js + capability-registry.js | 支持的约束能力注册表 |
| entity-resolution.js + entity-binding.js | 教师/班级/科目实体识别与绑定 |
| source-identity.js + source-requirement.js | 约束来源追踪 |
| semantic-planning.js | 复杂语义规划（多实体/跨周约束） |
| parse-readiness.js + parse-cache.js | 解析预检与缓存 |
| ai-source-alignment.js | AI 输出与源文本对齐 |
| statistics.js | 解析统计 |

- **入口**：`timetable-rule-parser.js` 只保留 10 个公开编排函数；缓存、来源准备、artifact 构建与 IR 处理分别位于 `timetable-rule-parser-cache.js`、`timetable-rule-parser-sources.js`、`timetable-rule-parser-artifacts.js`、`timetable-rule-parser-ir.js`
- **AI 提取**：`timetable-ai-extractor.js` 保留 AI 调用、Prompt 与缓存实现，`timetable-ai-extraction-validator.js` 负责结果校验、语义规范化和实体引用解析
- **测试**：test/timetable-constraint-ir-137.test.js, test/timetable-capability-registry.test.js 等
- **常见改动**：
  - 新增约束类型 → capabilities.js 注册 + constraint-ir.js 定义 + rule-parser 识别 + solver-bridge 传递 + Java 端实现（全链路，属 L1-L2）

### 求解链路

#### gateway/services/timetable-solver-bridge.js
- **职责**：构造 solver 请求、调用 Timefold HTTP、轮询任务、结果转换回项目 schedule
- **关键导出**：`buildTimetableProblem`, `transformTimetableSolutionToSchedule`, `TimetableTimefoldError`, `canUseTimefoldForTimetable`, `resolveTimetableSolverTimeoutMs`
- **测试**：test/timetable-solver-bridge.test.js
- **配置**：TIMETABLE_SOLVER_TIMEOUT (210s), TIMETABLE_SOLVER_SPENT_LIMIT (180s)

#### gateway/services/timetable-scheduler.js
- **职责**：本地排课公共入口；`timetable-local-scheduler.js` 包含本地调度算法及其私有辅助，`timetable-diagnostic-scheduler.js` 只保留可行性分析与冲突组件诊断
- **测试**：test/timetable-scheduler.test.js

#### solver/src/main/java/com/icecream/timetable/
- **职责**：排课约束求解（Timefold，SchedulingUnit 批量模型）
- **关键类**：
  - domain/SchedulingUnit.java - 批量排课实体
  - domain/UnitPlacement.java - 放置候选
  - solver/TimetableConstraintProvider.java - 约束定义
  - solver/CompatiblePlacementSwapMove.java - 自定义交换算子
  - solver/SchedulingUnitFactory.java - 单元构建
- **测试**：`npm run solver:test`

### Agent 编排子系统 (timetable-agent/)

**职责**：把用户的对话意图分解成多步骤工作流（数据准备 → 约束录入 → 求解 → 诊断 → 发布），维护会话状态。

**文件结构：**
- `timetable-agent-core.js` - 会话管理与主调度：`createTimetableAgentSession`, `handleTimetableAgentMessage`, `runTimetableAgent`
- `timetable-agent-planner.js` - 意图分类与动作规划
- `timetable-agent-state.js` - 会话状态 CRUD
- `timetable-agent-tools.js` - 工具函数注册表
- `skills/` - 七个技能模块（constraint-intake、constraint、data-prep、diagnosis、publication、solve-plan、solve）

**依赖**：timetable-solver-bridge, timetable-rule-parser, timetable-conflicts, timetable-project 等

**测试**：test/timetable-agent-core.test.js

**常见改动**：
- 新增技能 → skills/ 下新建文件 + timetable-agent-core.js 注册 + timetable-agent-planner.js 意图路由

---

| 文件 | 职责 | 测试 |
|------|------|------|
| timetable-conflicts.js | 硬冲突检测（教师/班级/场地重叠） | test/timetable-diagnostics.test.js |
| timetable-validation.js + timetable-validation-service.js | 发布前校验 | test/ 多处 |
| timetable-diagnostics.js | 诊断报告生成 | test/timetable-diagnostics.test.js |
| timetable-diagnostic-scheduler.js | 可行性分析与冲突组件诊断 | test/timetable-diagnostics.test.js |
| timetable-local-scheduler.js | 本地调度算法与私有辅助 | test/timetable-scheduler.test.js |
| timetable-score.js | 课表质量评分 | - |

### 前端

#### public/js/tools/timetable-planner.js + timetable/
- **结构**：timetable-planner.js 为动态加载入口 → timetable/controller.js 主控制器
- **子模块**：
  - state.js - 状态管理（单一数据源）
  - view.js + view-*.js - 视图渲染
  - controller-*.js - 交互控制（约束对话框、智能助手、聊天）
  - api.js - 后端 API 封装
  - grid-interactions.js - 课表网格拖拽
  - forms.js - 表单处理
- **测试**：test/timetable-planner-ui.test.js + 多个专项测试
- **UI 冒烟**：npm run test:timetable:ui-smoke 系列
- **常见改动**：
  - UI 状态变更 → 只改 state.js + 对应 view
  - 新增 API 调用 → 只改 api.js

---

## Manim 模块（数学动画）

### manim-service/
- **职责**：数学动画渲染服务（独立 Python 进程）
- **结构**：
  - main.py - 兼容入口（转发 app.main）
  - app/main.py - FastAPI 应用
  - app/agent/ - AI 生成动画代码
  - app/legacy_main.py - 渲染管理（被 agent/renderer.py 动态引用，勿删）
  - app/agent/routes.py - Agent HTTP/SSE 端点注册
- **测试**：manim-service/tests/ (`unittest`)
- **常见改动**：
  - 新增动画模板 → app/prompts.py
  - 渲染参数调整 → app/service_config.py

---

## Chat 模块（AI 聊天）

### services/ (根目录)
- **职责**：聊天消息处理（被 gateway/middleware/intent-router.js 动态 import）
- **结构**：
  - chat/chat-handler.js - DeepSeek 对话
  - manim/manim-client.js - 动画服务客户端
  - solver/solver-handler.js - 解题处理
  - intent-classifier.js 在 gateway/services/ 下
- **注意**：此目录与 gateway/services/ 是两个不同目录（历史原因），新代码优先放 gateway/services/

---

## 跨模块协作规则

### 修改矩阵：改 X 需要看 Y

| 改动目标 | 必读文件 | 必跑测试 |
|---------|---------|---------|
| 座位约束类型 | seating-constraints.js + SeatingConstraintProvider.java | seating-constraints-parser + solver:test |
| 排课约束类型 | capabilities.js + constraint-ir.js + TimetableConstraintProvider.java | constraint-ir-137 + solver:test |
| 排课项目 Schema | timetable-project.js + CLAUDE.md 缓存策略 | project-normalization + 快照兼容验证 |
| Solver HTTP API | *-solver-bridge.js + *SolverResource.java | solver-bridge 测试 + solver:test |
| 前端工具 UI | 对应 tools/ 子目录 | 对应 ui 测试 + ui-smoke |
| 上传处理 | security.js | robustness-hardening |

### 接口稳定性分级

**冻结接口（改动属 L2，需项目书更新）：**
- HTTP API 路径与请求/响应 Schema
- data/timetable/projects.json 数据结构
- Solver HTTP 契约
- shared/ 下所有导出

**内部接口（改动属 L1，同模块内自由）：**
- 各 service 文件的内部函数
- 前端 panel 之间的调用

**实现细节（改动属 L0）：**
- 函数内部逻辑、算法优化、注释、格式
