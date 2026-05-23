# ICeCream

ICeCream 是一个面向学习、教学和内容生成的统一智能平台。它把 AI 对话、数学动画生成、题目图片解答、课堂座位规划放在同一个 Web 应用里，并通过 Node Gateway 统一连接 Python Manim 服务、Java Timefold Solver 和外部 AI API。

当前项目已经不是一个简单的 Express 页面。它由多个子项目组成：

- Node.js + Express Gateway
- 浏览器端原生 ES Module 前端
- Python FastAPI + Manim 渲染服务
- Java/Quarkus + Timefold 座位优化服务
- Manim Studio React/Konva 构建产物

后续维护和模块化改造请优先阅读：

- [PROJECT_READING_GUIDE.md](PROJECT_READING_GUIDE.md)

## 功能概览

| 功能 | 说明 | 主要依赖 |
| --- | --- | --- |
| AI 对话 | 普通聊天、流式聊天、统一消息入口和意图路由 | DeepSeek 兼容 API |
| 数学动画 | 自然语言生成 Manim 动画，支持 agent workflow、渲染、修复、参考图和失败回放 | Python Manim 服务、DeepSeek/模型 API |
| 智能解题 | 上传题目图片，进行 OCR/视觉理解和解答 | SiliconFlow、MinerU、DeepSeek |
| 座位规划 | AI 布局预览、名单导入、约束解析、本地排座、Timefold 优化、反馈和导出 | Node seating services、可选 Java Timefold |
| Manim Studio | 前端画布/代码工作台能力，构建后输出到 `public/js/studio/` | React、Konva、esbuild |

## 架构一览

```text
Browser
  -> public/index.html
  -> public/js/app.js
  -> gateway/server.js
  -> gateway/app.js
  -> gateway/routes/*
      -> services/chat/*
      -> services/solver/*
      -> services/manim/*
      -> gateway/services/seating-*
      -> manim-service/app/*
      -> solver/src/main/java/*
      -> external AI APIs
```

核心边界：

- `gateway/`：统一 HTTP 入口、静态资源、API 路由、中间件、启动任务。
- `services/`：Node 业务服务和外部服务适配。
- `public/`：浏览器端静态资源和工具 UI。
- `src/manim-studio/`：Manim Studio 源码，构建输出到 `public/js/studio/manim-studio-canvas.js`。
- `manim-service/`：Python Manim 服务和 agent 工作流。
- `solver/`：Java Timefold seating solver。
- `test/`、`manim-service/tests/`、`solver/src/test/`：Node、Python、Java 回归测试。

不要把这些目录当作源码审阅或提交重点：

- `node_modules/`
- `uploads/`
- `logs/`
- `solver/target/`
- `manim-service/static/`
- `manim-service/temp_gen/`
- `manim-service/.venv/`
- `manim-service/.pip-cache/`
- `**/__pycache__/`
- `public/js/libs/`
- `public/js/studio/manim-studio-canvas.js`

## 环境要求

| 运行时 | 要求 | 用途 |
| --- | --- | --- |
| Node.js | 18+ | Gateway、前端构建、Node 测试 |
| npm | 随 Node 安装 | 依赖安装和脚本运行 |
| Python | 3.12 | Manim 服务；`scripts/check-manim-env.js` 会强制检查 |
| Java | 21 | Timefold solver；`solver/pom.xml` 使用 `maven.compiler.release=21` |
| Maven Wrapper | 已包含在 `solver/mvnw.cmd` / `solver/mvnw` | 构建和测试 Java solver |

只有 Gateway 和前端是基础必需。Manim、Timefold、反馈邮件、MinerU 都是可选能力，缺少时对应功能会降级或不可用。

## 快速启动

### Windows 推荐方式

```batch
dev.bat
```

`dev.bat` 会做这些事：

- 如缺少 `.env`，从 `.env.example` 复制一份。
- 如缺少 `node_modules`，运行 `npm install`。
- 创建 `uploads/`、`logs/`、`manim-service/static/`、`manim-service/temp_gen/`。
- 检查 Python/Manim 环境，必要时创建 `manim-service/.venv` 并安装依赖。
- 如果 Java 和 `solver/mvnw.cmd` 可用，构建并启动 Timefold solver。
- 启动 Gateway 到 `http://localhost:3000`。
- 将 Manim 和 Timefold 日志写到 `logs/`。

只检查环境，不启动服务：

```batch
dev.bat --check
```

### 手动启动 Gateway

```batch
npm install
copy .env.example .env
npm start
```

PowerShell 可以使用：

```powershell
Copy-Item .env.example .env
npm start
```

Linux/macOS 可以使用：

```bash
npm install
cp .env.example .env
npm start
```

启动后访问：

```text
http://localhost:3000
```

### 单独启动 Manim 服务

推荐通过 npm 脚本启动，它会先检查并修复 Python 虚拟环境：

```bash
npm run manim
```

等价底层入口是：

```bash
cd manim-service
python main.py
```

如果 Manim 环境损坏，先运行：

```bash
node scripts/check-manim-env.js
```

### 单独启动 Timefold solver

开发模式：

```bash
npm run solver:dev
```

构建可运行包：

```bash
npm run solver:build
```

Gateway 只有在设置 `TIMEFOLD_SOLVER_URL` 后才会调用 Timefold；否则 seating 会使用本地排座 fallback。

常用本地地址：

```text
TIMEFOLD_SOLVER_URL=http://127.0.0.1:8081
```

## 环境变量

模板文件是 `.env.example`。复制后按需要填写 `.env`。

### Gateway 与服务端口

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Gateway 端口 |
| `MANIM_SERVICE_HOST` | `127.0.0.1` | Manim 服务监听地址 |
| `MANIM_SERVICE_PORT` | `8001` | Manim 服务端口 |
| `MANIM_SERVICE_URL` | `http://127.0.0.1:8001` | Gateway 调用 Manim 的地址 |
| `MANIM_SERVICE_TOKEN` | 空 | Manim 服务 token，可选 |
| `MANIM_AUTO_FREE_PORT` | `false` | Manim 是否自动释放端口 |

### 安全与限流

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CORS_ORIGIN` | `http://localhost:3000,http://127.0.0.1:3000` | 允许的来源 |
| `JSON_BODY_LIMIT` | `20mb` | JSON body 上限 |
| `FORM_BODY_LIMIT` | `20mb` | form body 上限 |
| `API_RATE_LIMIT_PER_MINUTE` | `120` | 通用 API 限流 |
| `MANIM_RENDER_RATE_LIMIT_PER_MINUTE` | `6` | Manim 渲染限流 |
| `OCR_RATE_LIMIT_PER_MINUTE` | `8` | OCR 限流 |

### AI 与外部能力

| 变量 | 必填场景 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 聊天、意图识别、seating AI、部分 Manim/solver 能力 | DeepSeek API key |
| `DEEPSEEK_API_BASE` | 同上 | DeepSeek 兼容 API 地址 |
| `DEEPSEEK_MODEL` | 同上 | 默认聊天模型 |
| `SILICONFLOW_API_KEY` | 图片解题/视觉识别 | SiliconFlow API key |
| `SILICONFLOW_API_BASE` | 图片解题/视觉识别 | SiliconFlow API 地址 |
| `SILICONFLOW_VLM_MODEL` | 图片解题/视觉识别 | 视觉语言模型 |
| `MINERU_API_KEY` | 可选 OCR fallback | MinerU API key |
| `MINERU_ENABLED` | 可选 OCR fallback | 是否启用 MinerU |

### Seating 与反馈

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TIMEFOLD_SOLVER_URL` | 空 | Timefold solver 地址；空值时使用本地 fallback |
| `TIMEFOLD_SOLVER_TIMEOUT` | `8` | Timefold 请求超时秒数 |
| `FEEDBACK_TO_EMAIL` | 空 | seating 反馈收件人 |
| `FEEDBACK_FROM_EMAIL` | 空 | seating 反馈发件人 |
| `FEEDBACK_LOG_DIR` | 空 | feedback 本地日志目录 |
| `SMTP_HOST` | 空 | SMTP 地址 |
| `SMTP_PORT` | `465` | SMTP 端口 |
| `SMTP_SECURE` | `true` | 是否使用安全连接 |
| `SMTP_USER` | 空 | SMTP 用户 |
| `SMTP_PASS` | 空 | SMTP 密码 |

## npm 脚本

| 命令 | 说明 |
| --- | --- |
| `npm start` | 启动 Gateway：`node gateway/server.js` |
| `npm run dev` | 使用 Node watch 模式启动 Gateway |
| `npm run manim` | 检查环境并启动 Python Manim 服务 |
| `npm run dev:all` | 同时启动 Gateway 和 Manim 服务 |
| `npm run solver:dev` | 进入 `solver/` 并启动 Quarkus dev |
| `npm run solver:test` | 运行 solver Maven 测试，默认可能占用 8081 |
| `npm run solver:build` | 构建 solver jar，跳过测试 |
| `npm run build:studio` | 构建 Manim Studio canvas bundle |
| `npm test` | 运行所有 Node 测试：`node --test test/*.js` |

## API 概览

Gateway 注册的主要 API：

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/api/health` | GET | Gateway 健康检查 |
| `/api/log` | POST | 开发环境前端日志桥 |
| `/api/message` | POST | 统一消息入口，支持图片上传和意图路由 |
| `/api/ai/status` | GET | AI 配置/状态 |
| `/api/chat` | POST | 普通聊天 |
| `/api/chat/stream` | POST | 流式聊天 |
| `/api/solver` | POST | 图片/题目解答 |
| `/api/solver/chat` | POST | 解题上下文聊天 |
| `/api/manim` | POST | Manim 生成入口 |
| `/api/manim/agent/stream` | POST | Manim agent 流式生成 |
| `/api/manim/render` | POST | Manim 代码渲染 |
| `/api/manim/suggestions` | POST | Manim 提示建议 |
| `/api/manim/status` | GET | Manim 服务状态 |
| `/api/manim/skills` | GET | Manim agent skills |
| `/api/manim/jobs` | GET | Manim jobs |
| `/api/manim/jobs/:jobId` | GET | 查询 Manim job |
| `/api/manim/jobs/:jobId/cancel` | POST | 取消 Manim job |
| `/api/manim/failures` | GET | 失败事件列表 |
| `/api/manim/failures/:eventId/replay` | POST | 失败事件回放 |
| `/api/manim/reference-images` | POST | 上传 Manim 参考图 |
| `/api/manim/patch` | POST | Manim Studio patch |
| `/api/manim/layout-rebuild` | POST | Manim layout rebuild |
| `/api/tools/health` | GET | 课堂工具服务状态 |
| `/api/tools/seating/arrange` | POST | AI + 本地/Timefold 排座 |
| `/api/tools/seating/layout-preview` | POST | AI 空教室布局预览 |
| `/api/tools/seating/suggestions` | POST | seating prompt 建议 |
| `/api/tools/seating/feedback` | POST | seating 反馈 |
| `/api/tools/seating/diagnostics` | GET | seating 诊断信息 |
| `/api/tools/seating/export-xlsx` | POST | 导出座位表 xlsx |
| `/api/tools/seating/parse` | POST | 自然语言约束解析 |
| `/api/tools/seating/plan` | POST | 教室布局 plan |
| `/api/tools/seating/parse-students` | POST | 文本名单解析 |
| `/api/tools/seating/parse-students-file` | POST | 文件名单解析 |
| `/api/tools/seating/parse-image` | POST | 图片名单 OCR |
| `/api/tools/seating/chat` | POST | seating AI 微调助手 |
| `/static/:filename` | GET | Manim 静态视频代理 |

## 测试与验证

Node 全量测试：

```bash
npm test
```

Gateway/安全聚焦测试：

```bash
node --test test/gateway-modules.test.js test/security-regression.test.js test/robustness-hardening.test.js
```

Seating 后端聚焦测试：

```bash
node --test test/seating-arrange.test.js test/seating-arrange-route.test.js test/seating-core.test.js
```

Seating 前端源码断言测试：

```bash
node --test test/seating-planner-ui.test.js test/mobile-responsive.test.js
```

Manim agent 测试：

```bash
cd manim-service
python -m unittest tests.test_agent
```

Solver 测试建议使用随机测试端口，避免本机 8081 冲突：

```powershell
cd solver
.\mvnw.cmd test "-Dquarkus.http.test-port=0"
```

## 目录说明

```text
ICeCream/
  gateway/                    Node/Express Gateway
    app.js                    Express app 装配
    server.js                 进程启动入口
    config/                   环境变量和路径
    middleware/               安全、限流、上传、错误处理
    routes/                   API 路由
    services/                 Gateway 内业务服务

  services/                   Node 跨路由业务服务
    chat/                     AI 聊天
    solver/                   图片解题和视觉服务适配
    manim/                    Gateway 到 Manim 的客户端

  public/                     浏览器静态资源
    index.html                前端页面入口
    css/                      样式
    js/                       原生 ES Module 前端代码

  src/manim-studio/           Manim Studio 源码

  manim-service/              Python FastAPI + Manim
    main.py                   兼容启动入口
    app/main.py               ASGI app 入口
    app/legacy_main.py        历史主实现，后续需要逐步瘦身
    app/agent/                Manim agent 工作流

  solver/                     Java/Quarkus Timefold solver
    pom.xml
    src/main/java/
    src/test/java/

  scripts/                    本地开发辅助脚本
  test/                       Node 测试
  uploads/                    运行时上传目录
  logs/                       本地开发日志
```

## 维护和模块化方向

本项目的详细模块化实施书在 [PROJECT_READING_GUIDE.md](PROJECT_READING_GUIDE.md)。这里保留最关键的维护规则：

- Gateway 入口保持薄：`server.js` 只负责启动，`app.js` 只负责装配。
- 路由只做 HTTP 适配；AI prompt、OCR fallback、排座算法、导出、反馈等业务逻辑下沉到 service。
- 后端不要直接依赖 `public/` 里的前端模块；前后端共享算法应迁到 `shared/<domain>/`。
- Seating 是当前最高优先级模块化目标：先拆 `gateway/services/seating-arrange.js`，再建立 `shared/seating`，再拆 `gateway/routes/tools.js`，最后拆前端 `SeatingPlanner`。
- Manim 不要继续扩大 `legacy_main.py`；新能力优先进入 `app/agent/`、`app/services/`、`app/runtime/` 或 `app/security/`。
- Java solver 结构相对稳定，后续只需要小步拆 `SeatingSolverResource.java` 中的 job store、response shaping 和 solver lifecycle。

新增功能放置规则：

- 新业务 API：`services/<domain>/` 或 `gateway/services/<domain>/` + `gateway/routes/<domain>.js`。
- 新课堂工具：前端入口放 `public/js/tools/<tool-name>.js`，复杂 UI 拆进同名目录。
- 新共享算法：放 `shared/<domain>/`，不要放 `public/js/utils/`。
- 新 Manim 能力：优先放 `manim-service/app/agent/` 或现有 adapter 目录。

## 常见问题

### `dev.bat` 启动后 Manim 被禁用

先运行：

```bash
node scripts/check-manim-env.js
```

如果提示找不到 Python 3.12，请安装 Python 3.12，或设置：

```powershell
$env:PYTHON_CMD = "py -3.12"
```

### Timefold 没有参与 seating

确认 Java 21 可用，并设置了：

```text
TIMEFOLD_SOLVER_URL=http://127.0.0.1:8081
```

如果没有配置，Gateway 会使用本地排座 fallback。

### `npm run solver:test` 端口冲突

使用随机测试端口：

```powershell
cd solver
.\mvnw.cmd test "-Dquarkus.http.test-port=0"
```

### AI 对话或 seating AI 不工作

检查 `.env`：

```text
DEEPSEEK_API_KEY=...
DEEPSEEK_API_BASE=...
```

同时确认网络能访问对应 API 地址。

### 图片解题或 OCR 不工作

检查：

```text
SILICONFLOW_API_KEY=...
SILICONFLOW_API_BASE=...
SILICONFLOW_VLM_MODEL=...
```

MinerU 是可选 fallback，只有配置 `MINERU_ENABLED=true` 和 `MINERU_API_KEY` 后才会使用。

## License

`package.json` 声明项目 license 为 MIT。若要对外正式发布，建议补充根目录 `LICENSE` 文件。
