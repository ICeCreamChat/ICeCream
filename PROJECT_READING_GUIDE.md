# ICeCream 项目阅读、模块化与功能接手实施书

这份文档是 ICeCream 后续维护、模块化改造、新功能接入的主交接文档。后续接手、拆分和新增功能都优先更新本文，避免路线信息分散到第二份 Markdown。

阅读建议：

1. 先读“项目边界”和“启动链路”，确认每个子项目负责什么。
2. 再读“模块化总原则”和“目标结构”，建立后续改造的方向。
3. 要动代码前，按“分阶段实施书”选择当前阶段，只做一个阶段内的一小步。
4. 新增功能前，先查“新增功能怎么放”，不要把新逻辑塞回已经过厚的文件。

## 1. 项目边界

ICeCream 是一个统一智能平台，整合 AI 聊天、Manim 视频动画、GeoGebra 动态几何、智能解题和课堂工具。当前仓库包含多个运行时，不要把它当成单一 Node 项目处理。

主要子项目：

- `gateway/`：Node.js + Express 网关，负责静态页面、统一 API、文件上传、限流、安全头、意图路由、工具 API 适配。
- `services/`：Node.js 业务服务，包含聊天、解题、Manim 客户端、GeoGebra 命令规划等跨路由复用能力。
- `public/`：浏览器静态资源，采用原生 ES Module 组织前端逻辑，并保存 GeoGebra 离线 HTML5 运行时。
- `manim-service/`：Python FastAPI + Manim 渲染服务，负责动画生成、agent 工作流和静态渲染产物。
- `solver/`：Java/Quarkus + Timefold seating solver，负责座位约束求解。
- `test/`、`manim-service/tests/`、`solver/src/test/`：Node、Python、Java 的回归测试。

整体请求流：

```text
Browser -> gateway/server.js -> gateway/app.js -> gateway/routes/*
        -> gateway/services/* 或 services/*
        -> external AI APIs / Python Manim service / GeoGebra Node services / Java Timefold solver
```

源码阅读时排除这些目录或文件，它们是依赖、运行时输出、缓存、构建产物或生成文件：

- `node_modules/`
- `solver/target/`
- `uploads/`
- `logs/`
- `manim-service/static/`
- `manim-service/.venv/`
- `manim-service/.pip-cache/`
- `**/__pycache__/`
- `public/js/libs/`
- `public/js/studio/manim-studio-canvas.js`

## 2. 启动链路

常用命令：

```bash
npm install
npm start
npm test
npm run manim
npm run dev:all
```

Windows 本地开发常用：

```batch
dev.bat
```

Gateway 主入口是 `gateway/server.js`。它只应该承担进程启动职责：

- 加载 `.env`
- 设置 DNS 优先 IPv4
- 校验关键环境变量
- 准备并清理 `uploads/`
- 创建 Express app
- 监听端口

Express app 装配在 `gateway/app.js`。测试和工具可以直接导入 `createGatewayApp()`，不会自动占用端口。

API 路由注册在 `gateway/routes/index.js`：

- `POST /api/message`：统一消息入口，经过图片上传和意图路由。
- `/api/ai`：AI 状态。
- `/api/chat`：直接聊天。
- `/api/manim`：Manim 网关代理。
- `/api/geogebra`：GeoGebra 状态、命令搜索、AI 作图规划、Studio 调整和失败修复。
- `/api/solver`：解题服务。
- `/api/tools`：课堂工具箱，目前 seating 相关逻辑最重。

## 3. 模块化总原则

这些原则比具体文件名更重要。任何模块化和新增功能都要先检查这些约束。

- **入口保持薄。** `server.js` 不写业务逻辑，`app.js` 不写具体业务实现，路由不写 AI prompt、求解算法或复杂解析。
- **路由只做 HTTP 适配。** 路由负责读取参数、调用 service、决定状态码和响应形状；业务判断放到 service 或 shared domain。
- **系统边界校验一次。** 请求体、上传文件、环境变量、外部 API 响应在边界归一化；内部显式不变量不要反复 `if x is None` / `if (!x)`。
- **shared 只放纯领域逻辑。** `shared/<domain>/` 不依赖 Express、DOM、fetch、process.env、localStorage 或浏览器 API。
- **命名必须具体。** 新文件和新函数不要叫 `utils`、`helper`、`manager`、`process`、`handler`、`data`、`info`、`result`。已有历史文件可以逐步迁移，但不要继续扩大。
- **不新增布尔参数表达特殊路径。** 真实分支应该用不同函数、不同路由或不同概念，例如布局预览和正式排座继续保持不同入口。
- **接口窄，实现厚。** 只 export 跨模块真正需要的函数；不要创建只转发一行调用的空层。
- **注释写 WHY。** 只解释约束、取舍、外部系统要求，不复述代码做了什么。
- **一次只拆一个职责。** 不要把“移动文件、改接口、改 UI、补功能”放进同一个提交。

## 4. 当前模块地图

### Gateway

推荐先读：

- `gateway/app.js`：Express app 装配总线。
- `gateway/config/environment.js`：环境变量加载、解析、校验。
- `gateway/config/paths.js`：项目关键路径。
- `gateway/middleware/core.js`：安全头、CORS、限流、body parser。
- `gateway/middleware/upload.js`：上传中间件；上传目录创建不在这里做。
- `gateway/startup/uploads.js`：上传目录创建和启动清理。
- `gateway/routes/index.js`：API 路由注册表。
- `gateway/routes/tools.js`：当前最需要拆分的路由文件。

当前边界要求：

- 新 API 放 `gateway/routes/<domain>.js`。
- 业务逻辑优先放 `gateway/services/<domain>.js` 或 `services/<domain>/`。
- 新中间件放 `gateway/middleware/`，再由 `gateway/app.js` 挂载。
- 新启动任务放 `gateway/startup/`，再由 `gateway/server.js` 调用。
- 新配置集中进 `gateway/config/environment.js` 和 `.env.example`。

### Node 业务服务

- `services/chat/chat-handler.js`：普通聊天和流式聊天，上游主要依赖 DeepSeek 兼容接口。
- `services/solver/solver-handler.js`：解题入口。
- `services/solver/siliconflow.js`、`services/solver/mineru.js`、`services/solver/deepseek.js`：不同外部能力适配。
- `services/solver/image-utils.js`、`services/solver/diagram-detector.js`：图片和图形识别辅助逻辑。
- `services/manim/manim-client.js`：Gateway 侧 Manim 客户端，`buildRenderPayload()` 已有回归测试覆盖。
- `services/geogebra/command-search.js`：加载 GeoGebra 命令索引，提供稳定搜索和状态检查。
- `services/geogebra/geogebra-agent.js`：复用 DeepSeek 兼容配置生成 GeoGebra 命令计划、Studio 调整计划和失败修复计划。
- `services/geogebra/geogebra-prompt.js`：GeoGebra 中文教学作图提示词。
- `gateway/routes/geogebra.js`：GeoGebra HTTP 适配层，只负责请求归一化、状态码和响应形状。

### Seating 后端

当前集中点：

- `gateway/services/seating-arrange.js`：请求归一化、AI prompt、AI JSON 修复、自然语言规则推断、布局生成、本地排座、Timefold 协调、评分优化、响应解释都在同一文件。
- `gateway/services/seating-layout.js`：布局 plan 相关逻辑，当前直接 import `public/js/tools/classroom-layout.js`。
- `gateway/services/seating-solver-bridge.js`：Node 到 Java Timefold solver 的适配，当前直接 import `public/js/tools/seating-core.js`。
- `gateway/routes/tools.js`：seating API、OCR、chat、反馈、诊断、导出、占位工具混在一起。

### 前端

- `public/js/app.js`：浏览器入口。
- `public/js/core/`：会话、消息、模式切换、图片上传、代码面板、Manim workbench、GeoGebra canvas/studio/workbench。
- `public/js/tools/`：课堂工具箱，目前 `seating-planner.js` 是最大 UI 单体。
- `public/js/utils/`：历史通用模块；不要继续把新领域逻辑放进去。
- `public/vendor/geogebra/`：GeoGebra HTML5 离线运行时，遵循 GeoGebra 自身非商业授权，不属于 ICeCream MIT 源码。
- `src/manim-studio/`：Manim Studio 源码，构建输出是 `public/js/studio/manim-studio-canvas.js`。

修改前端时先看：

1. `public/index.html` 的脚本加载顺序。
2. `public/js/app.js` 的初始化流程。
3. 对应 UI 源码测试，例如 `test/seating-planner-ui.test.js`。

### GeoGebra 动画子项目

GeoGebra 与 Manim 同属于“动画”能力，但二者是并行子项目：
- Manim 负责后端视频生成和渲染产物。
- GeoGebra 负责浏览器内动态几何画布、GeoGebra Studio、AI 命令规划、命令执行和失败修复。

当前边界：
- `public/js/core/manim-workbench.js`：只负责动画工作台入口和 Manim/GeoGebra 子模式切换，子模式保存在 `localStorage` 的 `icecream_animation_engine_v1`。
- `public/js/core/geogebra-canvas.js`：加载 `/vendor/geogebra/deployggb.js`，注入 applet，封装命令执行、画布读取、XML 快照恢复、视图切换、重置和导出。
- `public/js/core/geogebra-studio.js`：GeoGebra Studio UI 和本地会话状态，负责对象检查、AI 调整、命令编辑、历史、撤销/重做和导出。
- `public/js/core/geogebra-workbench.js`：GeoGebra 子项目编排层，把主输入框请求转成 `/api/geogebra/plan` 和 `/api/geogebra/repair` 调用，并把结果交给 Studio 执行。
- `services/geogebra/command-search.js`：从 `commands-index.json` 构建命令搜索索引，模块加载时构建一次。
- `services/geogebra/geogebra-agent.js`：复用 `DEEPSEEK_API_BASE`、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` 生成命令计划、Studio 调整和修复计划。
- `gateway/routes/geogebra.js`：暴露 `/api/geogebra/status`、`/api/geogebra/commands/search`、`/api/geogebra/plan`、`/api/geogebra/studio/adjust`、`/api/geogebra/repair`。
- `public/vendor/geogebra/`：从本地离线包 vendored 的 GeoGebra HTML5 运行时，授权见 `public/vendor/geogebra/LICENSE-GEOGEBRA.txt`。

维护约束：
- 不把 GeoGebra 逻辑塞进 Manim Python 服务；GeoGebra 第一版没有后端视频渲染。
- 不复用 `GGBTool离线包v2.7/lib/js/main.min.js` 这类混淆 UI 代码。
- 不新增顶部主模式；入口仍在“动画”工作台内部。
- 点击“GeoGebra 动态几何”后默认进入 GeoGebra Studio；Studio 本地会话键是 `icecream_geogebra_studio_v1`。
- Auto 模式只有用户明确提到 `geogebra`、`ggb`、`动态几何`、`几何画板`、`拖动点` 等词时才走 GeoGebra。
- GeoGebra AI 配置复用 DeepSeek 兼容变量，不在 `.env.example` 增加必填项。

### Manim Python 服务

- `manim-service/app/main.py`：当前直接暴露 `legacy_main.app`。
- `manim-service/app/legacy_main.py`：真实 FastAPI app 和大量旧实现所在文件。
- `manim-service/app/api/`：API schema 和 route 包装层。
- `manim-service/app/services/`、`runtime/`、`security/`：已经存在 adapter，但多数仍 import 回 `legacy_main.py`。
- `manim-service/app/agent/`：较新的 agent 模块，已经比 legacy 主文件更模块化。

Manim 模块化优先级：

1. 不扩大 `legacy_main.py`。
2. 先把 adapter 做实。
3. 最后才改 `app/main.py` 的 app factory。
4. 暂不拆 `agent/workflow.py`，除非先补更窄的 workflow 集成测试。

### Java Solver

- `solver/src/main/java/com/icecream/seating/domain/`：求解领域对象。
- `solver/src/main/java/com/icecream/seating/solver/SeatingConstraintProvider.java`：Timefold 约束定义。
- `solver/src/main/java/com/icecream/seating/rest/SeatingSolverResource.java`：REST 资源，目前同时承担请求校验、job 存储、solver 生命周期、响应 shaping。
- `solver/src/test/java/...`：constraint provider 和 REST resource 测试。

Solver 当前结构相对清楚，后置处理即可。

## 5. 推荐目标结构

目标不是一口气建完所有目录，而是让每次迁移都朝这个结构收敛。

```text
gateway/
  routes/
    index.js
    geogebra.js
    seating.js
    seating-roster.js
    seating-feedback.js
    tool-placeholders.js
  services/
    seating/
      arrange-request.js
      arrangement-spec.js
      ai-arrangement-client.js
      layout-preview.js
      layout-builder.js
      local-assignment.js
      assignment-refinement.js
      score-optimizer.js
      arrangement-response.js
    seating-arrange.js

shared/
  seating/
    classroom-layout.js
    seating-core.js

services/
  geogebra/
    command-search.js
    geogebra-agent.js
    geogebra-prompt.js

public/
  vendor/
    geogebra/
      deployggb.js
      HTML5/
      LICENSE-GEOGEBRA.txt
  js/
    core/
      geogebra-canvas.js
      geogebra-studio.js
      geogebra-workbench.js
    tools/
      seating-planner.js
      seating-planner/
        planner-state.js
        roster-editor.js
        layout-preview-panel.js
        grid-renderer.js
        assistant-panel.js
        score-panel.js
        export-actions.js
        feedback-dialog.js

manim-service/
  app/
    main.py
    api/
    services/
    runtime/
    security/
    agent/

solver/
  src/main/java/com/icecream/seating/
    domain/
    solver/
    rest/
```

目标结构说明：

- `gateway/services/seating-arrange.js` 保留为兼容门面，直到所有调用方迁移完成。
- `gateway/services/seating/` 的文件名必须表达具体业务能力，不新增 `seating-utils.js`。
- `shared/seating/` 只能包含前后端都能运行的纯逻辑。
- `public/js/tools/seating-planner/` 只放前端 UI 和浏览器交互逻辑。
- `services/geogebra/` 只放 Node 侧命令索引、AI 规划、Studio 调整和修复；不新增 Python、Java 或独立 GeoGebra 进程。
- `public/js/core/geogebra-*` 只放动画工作台内的 GeoGebra 前端运行时、Studio 和 UI 委托。
- `public/vendor/geogebra/` 是 vendored 离线运行时，升级时整体替换并同步授权说明。
- Python adapter 目录使用现有 `services`、`runtime`、`security` 名称，但每个文件要承接真实实现。
- Java solver 不需要大规模目录重排，只拆 REST resource 的内部职责。

## 6. 分阶段实施书

### Phase 1：拆后端 `seating-arrange.js`

目标：

- 降低 `gateway/services/seating-arrange.js` 的维护成本。
- 保持现有 Node tests 和 HTTP API 行为不变。
- 让后续 shared/seating 和 routes 拆分有稳定 service 边界。

不改：

- 不改 `/api/tools/seating/arrange`。
- 不改 `/api/tools/seating/layout-preview`。
- 不改 `runAiLayoutPreview`、`runAiDrivenArrangement` 的调用方式。
- 不改响应字段、错误文案和 fallback 行为。
- 不把预览和正式排座合并成一个带 `mode` 或布尔参数的函数。

建议模块：

- `gateway/services/seating/arrange-request.js`
  - 承接 `normalizeArrangeRequest`、学生列表归一化、基础文本/数字/布尔解析。
  - 这是系统边界，允许在这里做请求校验。
- `gateway/services/seating/ai-arrangement-client.js`
  - 承接 AI JSON 请求、`parseAiJson`、repair prompt、stage retry。
  - 不包含本地排座算法。
- `gateway/services/seating/arrangement-spec.js`
  - 承接自然语言 spec 推断、AI spec 归一化、策略覆盖和冲突 warning。
- `gateway/services/seating/layout-builder.js`
  - 承接可扩容布局、混合列模式、分组、护法布局。
- `gateway/services/seating/layout-preview.js`
  - 承接 `runAiLayoutPreview` 内部流程，但公开入口仍由门面导出。
- `gateway/services/seating/local-assignment.js`
  - 承接本地学生排序、护法选择、初始座位分配。
- `gateway/services/seating/assignment-refinement.js`
  - 承接不满足约束的局部微调和 refinement。
- `gateway/services/seating/score-optimizer.js`
  - 承接 `optimizeSeatingScore` 和座位质量比较。
- `gateway/services/seating/arrangement-response.js`
  - 承接解释文本、stats、solver facts、warnings 聚合。

迁移顺序：

1. 先移动纯请求归一化：`normalizeArrangeRequest` 和它直接依赖的小函数。
2. 再移动 AI JSON 解析和 request stage retry，保持测试 mock 不变。
3. 再移动 arrangement spec 推断和归一化。
4. 再移动 layout builder，不改 `classroom-layout` import。
5. 再移动 local assignment。
6. 再移动 refinement 和 score optimizer。
7. 最后让 `seating-arrange.js` 只保留公开导出和流程编排。

验收标准：

- `gateway/services/seating-arrange.js` 不再包含大段纯算法实现。
- 所有现有导出仍可从 `gateway/services/seating-arrange.js` import。
- 每个新文件只 export 跨模块需要的函数。
- 没有新增泛名文件，也没有新增布尔特殊路径参数。

测试命令：

```bash
node --test test/seating-arrange.test.js test/seating-arrange-route.test.js test/seating-solver-bridge.test.js test/seating-core.test.js
npm test
```

### Phase 2：建立 `shared/seating`

目标：

- 消除后端直接 import `public/js/tools/classroom-layout.js` 和 `public/js/tools/seating-core.js` 的耦合。
- 让 seating 领域算法成为真正的前后端共享模块。

不改：

- 不改前端 UI。
- 不改 layout 数据结构。
- 不改 seating-core 对外行为。
- 不一次性删除旧路径。

建议模块：

- `shared/seating/classroom-layout.js`
  - 承接 `CELL`、`createClassroomLayout`、`applyAiLayoutMatrix`、`getLayoutCapacity`、`layoutMatrix`、`parseClassroomLayoutPrompt` 等纯布局逻辑。
- `shared/seating/seating-core.js`
  - 承接座位操作、约束评估、质量评分、local aisle 处理等纯领域逻辑。

迁移顺序：

1. 复制纯逻辑到 `shared/seating/`，先不删旧文件。
2. 更新 Node tests 直接 import `shared/seating`，确认行为一致。
3. 更新后端 `gateway/services/seating-layout.js`、`seating-solver-bridge.js`、`seating-arrange.js` 的 import。
4. 让 `public/js/tools/classroom-layout.js` 和 `public/js/tools/seating-core.js` 临时 re-export `shared/seating`。
5. 更新前端 `public/js/tools/seating-planner.js` 的 import。
6. 确认没有后端再 import `public/js/tools/*`。

验收标准：

- `rg "public/js/tools/(classroom-layout|seating-core)|\\.\\./\\.\\./public/js/tools" gateway services` 没有命中。
- shared 模块不依赖 DOM、Express、fetch、process.env。
- 前端测试和后端 seating 测试都通过。

测试命令：

```bash
node --test test/classroom-layout.test.js test/seating-core.test.js test/seating-arrange.test.js test/seating-solver-bridge.test.js
npm test
```

### Phase 3：拆 `gateway/routes/tools.js`

目标：

- 让工具路由按业务能力拆开。
- 路由层只做 HTTP 适配，不再承载 prompt、OCR fallback、chat 调整细节。

不改：

- 不改 `/api/tools/*` URL。
- 不改上传字段名：`image`、`file` 等保持不变。
- 不改响应 shape。
- 不改 multer 限制，除非单独做上传安全改造。

建议模块：

- `gateway/routes/seating.js`
  - `/seating/arrange`
  - `/seating/layout-preview`
  - `/seating/plan`
  - `/seating/parse`
  - `/seating/chat`
  - `/seating/suggestions`
- `gateway/routes/seating-roster.js`
  - `/seating/parse-students`
  - `/seating/parse-students-file`
  - `/seating/parse-image`
- `gateway/routes/seating-feedback.js`
  - `/seating/feedback`
  - `/seating/diagnostics`
  - `/seating/export-xlsx`
- `gateway/routes/tool-placeholders.js`
  - `/vote/create`
  - `/picker/students`
- `gateway/routes/tools.js`
  - 只创建 router 并挂载上述子路由。

需要下沉到 service 的逻辑：

- `/seating/plan` 中的 DeepSeek layout prompt。
- `/seating/chat` 中的 seating chat prompt 和 AI response parsing。
- `/seating/parse-image` 中的 OCR fallback 编排。

迁移顺序：

1. 先拆占位路由，风险最低。
2. 再拆 feedback、diagnostics、export。
3. 再拆 roster 文本/文件解析。
4. 再拆 image OCR，但先保留 service 调用顺序不变。
5. 最后拆 arrange、preview、plan、chat。
6. 每拆一组就运行对应 route test。

验收标准：

- `gateway/routes/tools.js` 只负责聚合注册。
- 新路由文件没有大段 AI prompt。
- 所有 `/api/tools/*` 测试继续通过。

测试命令：

```bash
node --test test/seating-arrange-route.test.js test/seating-layout-route.test.js test/seating-image-import.test.js test/seating-feedback.test.js test/seating-export-xlsx.test.js test/seating-chat.test.js
npm test
```

### Phase 4：拆前端 `SeatingPlanner`

目标：

- 降低 `public/js/tools/seating-planner.js` 的 UI 维护成本。
- 让 roster、布局预览、网格渲染、AI 助手、评分、导出、反馈可以独立维护。

不改：

- 不改首屏体验。
- 不改 DOM 关键文案和结构，除非对应测试同步更新。
- 不改 `/api/tools/seating/*` 调用路径。
- 不引入新前端框架。

建议模块：

- `public/js/tools/seating-planner/planner-state.js`
  - 状态初始值、snapshot、状态转换。
- `public/js/tools/seating-planner/roster-editor.js`
  - 名单导入、编辑、review dialog。
- `public/js/tools/seating-planner/layout-preview-panel.js`
  - 布局预览请求、确认、编辑提示。
- `public/js/tools/seating-planner/grid-renderer.js`
  - 座位格、过道、护法位、虚拟渲染。
- `public/js/tools/seating-planner/assistant-panel.js`
  - AI seating assistant 浮窗、确认流程。
- `public/js/tools/seating-planner/score-panel.js`
  - score summary、warning chip、展开分析。
- `public/js/tools/seating-planner/export-actions.js`
  - PNG/XLSX 导出。
- `public/js/tools/seating-planner/feedback-dialog.js`
  - 截图、脱敏、反馈提交。

迁移顺序：

1. 先抽不碰 DOM 的纯状态转换。
2. 再抽 API 调用包装，保持 fetch 路径不变。
3. 再抽 roster editor。
4. 再抽 layout preview panel。
5. 再抽 score 和 export。
6. 再抽 feedback dialog。
7. 最后抽 grid renderer 和 assistant panel，因为交互风险最高。

验收标准：

- `seating-planner.js` 成为 orchestrator，不再包含所有 UI 细节。
- 所有源码断言测试继续通过。
- 大网格虚拟渲染、local aisle、护法位、评分展示、反馈截图功能不回退。

测试命令：

```bash
node --test test/seating-planner-ui.test.js test/seating-core.test.js test/mobile-responsive.test.js
npm test
```

### Phase 5：Manim legacy 退场

目标：

- 让 `manim-service/app/legacy_main.py` 不再是所有真实实现的汇总点。
- 逐步把已有 adapter 文件变成真实实现文件。

不改：

- 不先改 Manim 服务端口。
- 不先改 Gateway 到 Manim 的 API。
- 不先拆 `app/agent/workflow.py`。
- 不删除 `legacy_main.py`，直到入口和测试都稳定。

建议迁移：

- `manim-service/app/security/code_validation.py`
  - 承接 `validate_code_completeness`、`validate_code_security`。
- `manim-service/app/runtime/process_manager.py`
  - 承接 `RenderProcessManager`、`run_manim_safe`。
- `manim-service/app/services/cache_service.py`
  - 承接 `load_cache`、`get_cached_video`、`save_cache_entry`。
- `manim-service/app/services/render_service.py`
  - 承接 `render_code_directly`、`find_video_file`、`find_image_file`。
- `manim-service/app/services/ai_service.py`
  - 承接 chat workflow 和 code modification 的 AI 编排。
- `manim-service/app/main.py`
  - 最终改为 app factory 和 uvicorn 入口。

迁移顺序：

1. 先迁移纯安全校验函数，补或复用 Python unit test。
2. 再迁移缓存读写。
3. 再迁移静态文件查找。
4. 再迁移渲染进程管理。
5. 再迁移直接渲染和 websocket 工作流。
6. 最后重组 `app/main.py`，让 `legacy_main.py` 只保留兼容导入。

验收标准：

- `rg "legacy_main" manim-service/app/services manim-service/app/security manim-service/app/runtime` 命中逐步减少。
- 新代码不再把实现从 adapter import 回 legacy。
- Agent 测试保持通过。

测试命令：

```bash
cd manim-service
python -m unittest tests.test_agent
```

### Phase 6：Java solver 小整理

目标：

- 保持 Java solver 的领域模型和 Timefold 约束稳定。
- 只拆 `SeatingSolverResource.java` 中过多的资源层职责。

不改：

- 不改 REST 路径。
- 不改 Node gateway 的 solver payload。
- 不改 `SeatingConstraintProvider` 约束语义。

建议模块：

- `rest/SeatingSolverResource.java`
  - 只保留 JAX-RS 注解、请求读取、响应返回。
- `rest/SolverJobStore.java`
  - 承接 job map、job lookup、job delete。
- `rest/SeatingSolutionResponses.java`
  - 承接 response body shaping。
- `rest/SeatingSolverLifecycle.java`
  - 承接 solverManager 调用和状态转换。

迁移顺序：

1. 先抽 job storage。
2. 再抽 response shaping。
3. 再抽 solver lifecycle。
4. 最后瘦身 resource。

验收标准：

- REST resource 不再直接维护所有 job 和 solver lifecycle 细节。
- domain 和 constraint provider 不变。
- Quarkus REST tests 通过。

测试命令：

```powershell
cd solver
.\mvnw.cmd test "-Dquarkus.http.test-port=0"
```

## 7. 新增功能怎么放

### 新业务 API

放置规则：

1. 业务处理函数放 `services/<domain>/` 或 `gateway/services/<domain>/`。
2. HTTP 入口放 `gateway/routes/<domain>.js`。
3. 在 `gateway/routes/index.js` 注册。
4. 前端调用放到 `public/js/api_client.js` 或对应前端领域模块。
5. 增加 route test 或 service pure function test。

不要：

- 不要把外部 API 调用直接写进 route。
- 不要在前端直接调用外部 AI API。
- 不要新增 `gateway/routes/tools.js` 中的大段特殊逻辑。

### 新课堂工具

放置规则：

1. 前端工具入口放 `public/js/tools/<tool-name>.js`。
2. 工具内部复杂 UI 拆成 `public/js/tools/<tool-name>/`。
3. 后端能力放 `gateway/services/<tool-name>/` 或 `services/<tool-name>/`。
4. 路由放 `gateway/routes/<tool-name>.js`，再由聚合路由注册。
5. shared 算法放 `shared/<tool-name>/`，不要放 `public/`。

### 新 seating 能力

放置规则：

- 改布局规则：优先看 `shared/seating/classroom-layout.js` 和 `gateway/services/seating/layout-builder.js`。
- 改排座策略：优先看 `gateway/services/seating/local-assignment.js`、`assignment-refinement.js`、`score-optimizer.js`。
- 改 AI 需求理解：优先看 `gateway/services/seating/arrangement-spec.js`。
- 改前端座位表 UI：优先看 `public/js/tools/seating-planner/` 下对应 panel。
- 改 Timefold payload：优先看 `gateway/services/seating-solver-bridge.js` 和 `solver/src/main/java/...`。

### 新共享算法

放置规则：

- 前后端都要用：`shared/<domain>/`。
- 只后端用：`gateway/services/<domain>/` 或 `services/<domain>/`。
- 只前端 UI 用：`public/js/tools/<tool-name>/` 或 `public/js/core/`。

shared 模块禁止依赖：

- Express request/response
- DOM
- localStorage
- process.env
- fetch
- Node-only fs/path，除非明确只服务 Node 且不叫 shared

### 新 Manim 能力

放置规则：

- Agent 生成链路能力：优先放 `manim-service/app/agent/`。
- 渲染服务能力：放 `manim-service/app/services/render_service.py`。
- 进程控制能力：放 `manim-service/app/runtime/process_manager.py`。
- 代码安全能力：放 `manim-service/app/security/code_validation.py`。
- API schema 或 route：放 `manim-service/app/api/`。

不要：

- 不要继续扩大 `legacy_main.py`。
- 不要让新的 adapter 再 import 回 legacy 获取真实实现。

### 新 GeoGebra 能力

放置规则：

- 新命令搜索或语法索引能力：放 `services/geogebra/command-search.js`，索引文件放 `services/geogebra/commands-index.json`。
- 新 AI 作图规划或 Studio 调整能力：放 `services/geogebra/geogebra-agent.js` 或明确的新领域文件，提示词放 `services/geogebra/geogebra-prompt.js`。
- 新 HTTP 能力：放 `gateway/routes/geogebra.js`，保持 route 只做 HTTP 适配。
- 新画布运行时能力：放 `public/js/core/geogebra-canvas.js`。
- 新 Studio UI 能力：放 `public/js/core/geogebra-studio.js`；如果继续变大，再拆成 `public/js/core/geogebra/` 下的明确子模块。
- 新工作台编排能力：放 `public/js/core/geogebra-workbench.js`，保持它只做状态和调用委托。
- 离线 GeoGebra 运行时升级：整体替换 `public/vendor/geogebra/`，并检查 `LICENSE-GEOGEBRA.txt`。

不要：

- 不要新增单独 GeoGebra 后端进程，除非未来明确需要服务端渲染。
- 不要把 GeoGebra 作为顶部主模式；它是动画工作台内的子模式。
- 不要把 GeoGebra 命令执行逻辑写进 `message-handler.js`；主输入框只负责路由，执行留给 GeoGebra Studio/workbench。
- 不要把 vendored GeoGebra 资源描述为 ICeCream 自有 MIT 代码。

### 新环境变量

同时更新：

- `.env.example`
- `gateway/config/environment.js`
- 本文档的环境变量说明
- 对应测试或启动校验

## 8. 测试与验收

常用 Node 全量测试：

```bash
npm test
```

后端 seating 聚焦测试：

```bash
node --test test/seating-arrange.test.js test/seating-arrange-route.test.js test/seating-core.test.js
```

shared seating 迁移测试：

```bash
node --test test/classroom-layout.test.js test/seating-core.test.js test/seating-arrange.test.js
```

工具路由拆分测试：

```bash
node --test test/seating-layout-route.test.js test/seating-image-import.test.js test/seating-feedback.test.js test/seating-export-xlsx.test.js test/seating-chat.test.js
```

前端 seating 源码断言测试：

```bash
node --test test/seating-planner-ui.test.js test/mobile-responsive.test.js
```

GeoGebra 聚焦测试：

```bash
node --test test/geogebra-studio-ui.test.js test/geogebra-command-search.test.js test/geogebra-route.test.js test/geogebra-ui-integration.test.js
```

Manim agent 测试：

```bash
cd manim-service
python -m unittest tests.test_agent
```

Java solver 测试：

```powershell
cd solver
.\mvnw.cmd test "-Dquarkus.http.test-port=0"
```

说明：

- `npm run solver:test` 可能因本机 8081 端口占用失败；优先使用随机测试端口命令。
- 文档-only 改动不需要跑完整测试，但要确认 UTF-8 读取正常。
- 代码模块化每完成一个职责迁移，就先跑对应聚焦测试，再跑更大测试集。

## 9. 交接检查清单

接手者开始工作前：

- [ ] 读取 `README.md`。
- [ ] 读取本文档。
- [ ] 查看 `git status --short`，确认是否有他人本地改动。
- [ ] 确认当前任务属于哪个阶段。
- [ ] 找到对应测试文件。
- [ ] 只选一个职责开始迁移。

每次提交前：

- [ ] 没有误提交 `node_modules/`、`uploads/`、`logs/`、`solver/target/`、`manim-service/static/`、`.venv/`、`.pip-cache/`。
- [ ] 没有新增泛名模块。
- [ ] 没有新增布尔特殊路径参数。
- [ ] 没有把后端逻辑放进 `public/`。
- [ ] 没有让 route 承担业务算法。
- [ ] 聚焦测试已通过。
- [ ] 必要时全量 `npm test` 已通过。

## 10. 当前已知状态

- `gateway/middleware/upload.js` 已改为使用 `gateway/config/paths.js` 中的 `gatewayPaths.uploadsDir`。
- 上传目录创建和清理由 `gateway/startup/uploads.js` 在启动边界负责。
- GeoGebra 已作为动画工作台内的并行 Studio 子项目接入，当前边界是 `services/geogebra/`、`gateway/routes/geogebra.js`、`public/js/core/geogebra-*`、`public/vendor/geogebra/`。
- 后端 seating、前端 SeatingPlanner、shared seating、tools route、Manim legacy 是主要模块化目标。
- Java solver 结构相对清楚，作为后期小整理处理。
- `PROJECT_READING_GUIDE.md` 是唯一主接手文档；不要再新增第二份路线图分散维护信息。
