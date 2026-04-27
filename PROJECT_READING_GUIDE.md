# ICeCream 项目阅读与接手指南

这份文档给后续维护人员快速建立项目地图。阅读顺序建议是：先看启动链路，再看三类业务服务，最后看前端模块和测试。

## 1. 项目是什么

ICeCream 是一个统一智能平台，主要由三部分组成：

- `gateway/`：Node.js + Express 网关，负责静态页面、统一 API、文件上传、限流、安全头、意图路由。
- `services/`：Node.js 业务服务，包含聊天、解题、Manim 客户端。
- `manim-service/`：Python Manim 渲染服务，负责实际动画生成。
- `public/`：浏览器端静态资源，采用原生 ES Module 组织前端逻辑。

整体请求流：

```text
Browser -> gateway/server.js -> gateway/app.js -> gateway/routes/*
        -> services/chat | services/solver | services/manim
        -> external AI APIs / Python Manim service
```

## 2. 启动入口

常用命令：

```bash
npm install
npm start
npm test
npm run manim
npm run dev:all
```

主入口是 `gateway/server.js`。它现在只负责启动职责：

- 加载 `.env`
- 设置 DNS 优先 IPv4
- 校验关键环境变量
- 准备并清理 `uploads/`
- 创建 Express app
- 监听端口

Express app 的实际装配在 `gateway/app.js`。测试或后续工具可以直接导入 `createGatewayApp()`，不会自动占用端口。


## 3. Gateway 模块边界

推荐从这些文件读起：

- `gateway/app.js`：Express app 装配总线。
- `gateway/config/environment.js`：环境变量加载、解析、校验。
- `gateway/config/paths.js`：项目关键路径。
- `gateway/middleware/core.js`：安全头、CORS、限流、body parser。
- `gateway/middleware/request-logger.js`：开发环境请求日志。
- `gateway/middleware/error-handler.js`：统一错误响应。
- `gateway/startup/uploads.js`：上传目录创建和启动清理。
- `gateway/routes/index.js`：API 路由注册表。
- `gateway/routes/static-video.js`：Manim 静态视频代理。
- `gateway/routes/health.js`：健康检查。
- `gateway/routes/frontend-log.js`：开发环境前端日志桥。

新增网关功能时优先遵守这个边界：

- 新 API：新增或修改 `gateway/routes/*.js`，业务逻辑放到 `services/`。
- 新中间件：放入 `gateway/middleware/`，再由 `gateway/app.js` 挂载。
- 新启动任务：放入 `gateway/startup/`，再由 `gateway/server.js` 调用。
- 新配置：放入 `gateway/config/environment.js`，避免散落读取 `process.env`。

## 4. 业务服务

`services/chat/chat-handler.js`

- 处理普通聊天和流式聊天。
- 上游主要依赖 DeepSeek 兼容接口。

`services/solver/`

- `solver-handler.js` 是解题入口。
- `siliconflow.js`、`mineru.js`、`deepseek.js` 负责不同外部能力。
- `image-utils.js`、`diagram-detector.js` 处理图片和图形识别辅助逻辑。

`services/manim/manim-client.js`

- 网关侧 Manim 客户端。
- 负责向 Python 服务提交生成或渲染请求。
- `buildRenderPayload()` 已有回归测试覆盖。

## 5. 前端模块

前端入口是 `public/js/app.js`，已经按功能拆分：

- `public/js/core/`：会话、消息、模式切换、图片上传、代码面板。
- `public/js/tools/`：课堂工具箱，例如座位表。
- `public/js/utils/`：markdown、sanitize、通用 helper。
- `public/js/*.js`：较早迁移来的兼容模块，例如数学渲染、主题、粒子效果等。

修改前端时，先看 `public/index.html` 的脚本加载顺序，再看 `public/js/app.js` 的初始化流程。

## 6. 环境变量

模板文件是 `.env.example`。常见变量：

- `PORT`：Gateway 端口，默认 `3000`。
- `DEEPSEEK_API_KEY`、`DEEPSEEK_API_BASE`：聊天和部分工具依赖。
- `SILICONFLOW_API_KEY`：视觉或解题能力依赖。
- `MANIM_SERVICE_URL`：Python Manim 服务地址，默认 `http://localhost:8001`。
- `API_RATE_LIMIT_PER_MINUTE`：通用 API 限流。
- `MANIM_RENDER_RATE_LIMIT_PER_MINUTE`：动画渲染限流。
- `OCR_RATE_LIMIT_PER_MINUTE`：OCR 识别限流。

新增环境变量时，同时更新：

- `.env.example`
- `gateway/config/environment.js`
- 本文档的这一节

## 7. 测试与验证

当前测试命令：

```bash
npm test
```

测试文件：

- `test/security-regression.test.js`：安全、上传、Manim payload、Python 服务安全回归。
- `test/gateway-modules.test.js`：Gateway 模块边界、上传清理、Manim 代理地址规范化。

重构建议：

- 修改共享工具或安全逻辑时，先补 `node:test` 回归测试。
- 修改 API 行为时，优先新增路由级测试或可单测的纯函数。
- 修改前端交互时，建议后续引入 Playwright 覆盖关键用户流。

## 8. 常见改动路径

新增一个业务 API：

1. 在 `services/<domain>/` 写业务处理函数。
2. 在 `gateway/routes/<domain>.js` 暴露 HTTP 路由。
3. 在 `gateway/routes/index.js` 注册路由。
4. 在 `public/js/api_client.js` 或对应前端模块调用。
5. 补测试并运行 `npm test`。

新增一个课堂工具：

1. 前端入口放在 `public/js/tools/`。
2. 样式放在 `public/css/`。
3. 后端 API 放在 `gateway/routes/tools.js`，复杂逻辑再抽到 `services/`。
4. 在工具启动器中注册入口。

调整启动行为：

1. 启动前任务放 `gateway/startup/`。
2. Express 装配放 `gateway/app.js`。
3. 端口监听和进程级副作用只放 `gateway/server.js`。

## 9. 维护原则

- 入口文件保持薄：`server.js` 不写业务逻辑，`app.js` 不写具体业务实现。
- 路由只做 HTTP 适配：参数读取、状态码、调用 service。
- service 保持可测试：尽量导出纯函数或可注入依赖的函数。
- 前端模块按用户能力拆分：聊天、图片、会话、工具箱各自维护自己的状态。
- 不要把外部 API 调用散落在路由和前端里，集中放到 service 层。
- 上传、限流、安全、清理这类横切能力统一放在 `gateway/middleware/` 或 `gateway/startup/`。
