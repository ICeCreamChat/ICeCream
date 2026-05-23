# ICeCream 模块化路线图

## 阅读范围

已阅读并梳理以下源码边界，排除了依赖、构建产物、运行时输出和生成文件：

- Node/Express 网关：`gateway/`
- Node 业务服务：`services/`
- 浏览器前端：`public/js/`、`src/manim-studio/`
- Python Manim 服务：`manim-service/app/`
- Java/Quarkus Timefold solver：`solver/src/`
- 测试：`test/`、`manim-service/tests/`、`solver/src/test/`

排除项包括 `node_modules/`、`solver/target/`、`logs/`、`uploads/`、`manim-service/static/`、`__pycache__/`、`.venv/`、`public/js/libs/`、`public/js/studio/manim-studio-canvas.js`。

## 当前架构

项目已经有清晰的一层运行时边界：

- `gateway/server.js`：启动入口，加载环境、准备上传目录、启动 HTTP 监听。
- `gateway/app.js`：Express app 组装，注册中间件、静态资源、API 路由、错误处理。
- `gateway/routes/*`：HTTP 适配层。
- `gateway/services/*` 和 `services/*`：网关内业务能力和外部服务适配。
- `public/js/*`：旧全局脚本和较新的 ES module 前端并存。
- `manim-service/app/*`：FastAPI Manim 服务，旧主应用和较新的 agent 模块并存。
- `solver/src/*`：Java Timefold solver，domain、constraint provider、REST 资源基本清楚。

## 主要维护风险

### 1. 座位安排后端集中在一个超大模块

`gateway/services/seating-arrange.js` 同时承担：

- 请求归一化
- AI prompt 构造
- AI JSON 解析和修复
- 自然语言规则推断
- 教室布局生成
- 本地排座算法
- Timefold 调用协调
- 评分优化
- 结果解释和统计

建议拆成领域能力模块，而不是拆成空的转发层：

- `gateway/services/seating/arrange-request.js`
- `gateway/services/seating/arrangement-spec.js`
- `gateway/services/seating/layout-planner.js`
- `gateway/services/seating/local-assignment.js`
- `gateway/services/seating/score-optimizer.js`
- `gateway/services/seating/arrangement-response.js`

保留 `runAiLayoutPreview` 和 `runAiDrivenArrangement` 两个公开入口，避免用布尔参数把“预览”和“正式排座”塞进一个函数。

### 2. 前端座位规划器是最大 UI 单体

`public/js/tools/seating-planner.js` 约 6788 行，混合：

- 状态初始化
- roster 导入和编辑
- 需求解析
- AI 布局预览
- 网格渲染和交互
- 本地回退排座
- 聊天助手
- 建议补全
- 评分展示
- 导出
- 反馈截图和诊断

建议按用户工作流拆分：

- `public/js/tools/seating-planner/state.js`
- `public/js/tools/seating-planner/roster-editor.js`
- `public/js/tools/seating-planner/layout-preview.js`
- `public/js/tools/seating-planner/grid-renderer.js`
- `public/js/tools/seating-planner/assistant-panel.js`
- `public/js/tools/seating-planner/score-panel.js`
- `public/js/tools/seating-planner/export-actions.js`
- `public/js/tools/seating-planner/feedback-dialog.js`

拆分时优先迁移纯函数和 DOM 渲染片段，最后再缩小 `SeatingPlanner` 类。

### 3. 前后端共享逻辑放在 `public/` 下

后端 `gateway/services/seating-layout.js`、`gateway/services/seating-solver-bridge.js`、`gateway/services/seating-arrange.js` 直接 import `public/js/tools/classroom-layout.js` 和 `public/js/tools/seating-core.js`。

这让浏览器资源目录变成了后端共享库目录。建议新增真正的共享领域目录：

- `shared/seating/classroom-layout.js`
- `shared/seating/seating-core.js`

迁移顺序：

1. 复制纯领域函数到 `shared/seating/`。
2. 后端改 import 到 `shared/seating/`。
3. 前端改 import 到 `shared/seating/`。
4. `public/js/tools/*` 只保留 UI 相关代码或兼容 re-export，最后删除兼容层。

### 4. `gateway/routes/tools.js` 路由层过厚

该文件混合了 seating plan、chat、OCR 图片解析、feedback、diagnostics、export、suggestions 和占位工具端点。

建议拆成：

- `gateway/routes/seating.js`
- `gateway/routes/tool-placeholders.js`
- `gateway/routes/tools.js` 只保留聚合注册

路由模块只做 HTTP 输入输出适配，prompt、AI 调用、OCR、导出、反馈继续下沉到服务模块。

### 5. Manim 服务仍以 `legacy_main.py` 为真实应用入口

`manim-service/app/main.py` 直接导入 `legacy_main.app`，同时 `security/`、`runtime/`、`services/` 多数文件只是再 import 回 `legacy_main`。

建议按现有 adapter 名称逐步把实现搬出：

- `app/security/code_validation.py` 承接代码完整性和安全检查。
- `app/runtime/process_manager.py` 承接渲染进程管理。
- `app/services/cache_service.py` 承接缓存读写。
- `app/services/render_service.py` 承接直接渲染和静态文件查找。
- `app/main.py` 最终变成 app factory，`legacy_main.py` 只作兼容入口后删除。

Manim agent 目录本身已经比较模块化，优先不要动 `workflow.py`，除非先给 workflow 阶段加更窄的集成测试。

### 6. `public/js/core/message-handler.js` 和 `code-panel.js` 混合 UI 与传输

`message-handler.js` 同时处理普通聊天、Manim streaming、进度气泡渲染、回复渲染、错误本地化。

建议拆成：

- Manim stream transport
- Manim progress bubble renderer
- Chat response renderer
- Error localization

`code-panel.js` 同时处理 Monaco、Studio canvas、自然语言编辑、patch、render 状态。建议先拆和 Manim Studio canvas 交互最稳定的纯适配层。

## 推荐迁移顺序

### 第 1 步：保护边界和测试入口

- 保留已有公开入口，不先改 API。
- 每次拆一个文件内的一个职责。
- 先跑对应的 `node --test` 文件，再跑更大测试集。
- 对 Python 和 Java 先不迁移运行入口，只记录 adapter 依赖。

### 第 2 步：后端 seating 领域函数迁移

优先迁移 `seating-arrange.js` 中相对纯的函数：

1. `normalizeArrangeRequest`
2. `validateAiArrangement`
3. arrangement spec 推断和归一化
4. layout planner
5. score optimizer

这样做的原因是 `test/seating-arrange.test.js` 覆盖最密，拆分后容易判断行为是否变化。

### 第 3 步：建立 `shared/seating`

把 `classroom-layout` 和 `seating-core` 的纯领域部分移到 `shared/seating`，消除后端 import `public/` 的耦合。

### 第 4 步：拆 `gateway/routes/tools.js`

当 seating 服务边界更清楚后，再把路由按工具能力拆开。这样路由文件不会只是搬家后的大文件。

### 第 5 步：拆前端 `SeatingPlanner`

先迁移不会改变 DOM 结构的纯状态转换和 API 调用，再迁移渲染片段。每一步用 `test/seating-planner-ui.test.js` 的源码断言保护 UI 文案和结构。

### 第 6 步：Manim legacy 退场

先让 adapter 文件拥有真实实现，再把 `app/main.py` 改成 app factory。`legacy_main.py` 应该最后处理，因为它当前承载真实运行入口。

## 已完成的首个小重构

`gateway/middleware/upload.js` 已改为使用 `gateway/config/paths.js` 中的 `gatewayPaths.uploadsDir`，不再自己计算项目根路径，也不再在模块 import 时创建上传目录。

上传目录创建和清理继续由 `gateway/startup/uploads.js` 在启动边界负责，符合“在系统边界验证一次”的原则。

## 后续改动约束

- 不新增布尔参数来表示特殊路径，已有“预览”和“正式排座”应保持不同入口。
- 新模块命名必须表达具体职责，避免 `utils`、`helper`、`manager`、`process` 等泛名。
- 迁移时只给真正需要跨模块调用的函数 export。
- 不在内部模块重复空值防御；请求归一化和文件上传这类外部边界负责校验。
- 注释只解释取舍、约束或外部系统要求，不复述代码。
