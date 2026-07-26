# ICeCream

ICeCream 是一个面向学习和教学场景的本地 AI 工作台。它把 AI 对话、题目解析、Manim 视频动画、GeoGebra 动态几何、座位规划、Timefold 排课式求解能力放在同一个浏览器入口里，方便课堂工具和实验能力继续扩展。

这个仓库的 README 只负责回答三件事：

- 项目能做什么。
- 本地怎么跑起来。
- 新接手开发者应该从哪里开始。

更细的模块化改造路线、文件职责、迁移顺序和验收命令，请看 [PROJECT_READING_GUIDE.md](PROJECT_READING_GUIDE.md)。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| AI 对话 | 通过 Node Gateway 统一接入大模型，支持普通对话和流式对话。 |
| 题目解析 | 支持文本、图片和 OCR 相关解题链路，图片能力依赖视觉模型或文档解析服务。 |
| Manim 视频动画 | Python 3.12 Manim 服务负责意图识别、代码生成、渲染任务和 Studio 预览。 |
| GeoGebra 动态几何 | 动画工作台内的并行 Studio，使用本地离线 GeoGebra HTML5 资源和 DeepSeek 兼容接口生成、调整、修复可交互作图命令，并可导出离线互动课件包供 PPT 超链接使用。 |
| 座位规划 | 提供名单解析、座位安排、布局预览、评分、导出、反馈等课堂工具能力。 |
| Timefold 求解 | Java 21 Quarkus 服务提供可选的 Timefold Solver 后端，用于更复杂的排布求解。 |
| 反馈邮件 | 可选 SMTP 配置，用于把用户反馈发送到维护者邮箱。 |

## 运行时组成

ICeCream 当前由几个边界清晰的子项目组成：

| 子项目 | 主要职责 |
| --- | --- |
| `gateway/` | Node.js HTTP 入口，提供静态页面、API 路由、安全中间件和服务编排。 |
| `services/` | Gateway 之外的 Node 业务服务，包括聊天、Manim 编排、GeoGebra 命令规划、Solver 桥接等能力。 |
| `public/` | 浏览器端页面、工具脚本、GeoGebra Studio、GeoGebra 离线资源和静态资源。 |
| `manim-service/` | Python Manim 服务，负责动画生成、渲染、运行时隔离和 agent 能力。 |
| `solver/` | Java 21 Quarkus + Timefold Solver 服务。 |
| `src/manim-studio/` | Studio 前端源码，构建产物输出到 `public/js/studio/`。 |

不要把运行时产物、依赖缓存或构建输出当作源码维护。常见排除项包括 `node_modules/`、`solver/target/`、`uploads/`、`logs/`、`manim-service/static/`、`.venv/`、`.pip-cache/`、`public/js/studio/`。

## 最快启动

### Windows 推荐方式

项目根目录已经提供 `dev.bat`。它会检查 Node 依赖、准备 `.env`、启动 Gateway，并尝试拉起 Manim 和 Timefold 相关服务。

```bat
cd /d D:\607document\ICeCream
dev.bat --check
copy .env.example .env
notepad .env
dev.bat
```

常用地址：

| 服务 | 默认地址 |
| --- | --- |
| Web 入口 | `http://localhost:3000` |
| Node Gateway 健康检查 | `http://localhost:3000/api/health` |
| Manim 服务 | `http://localhost:8001` |
| Timefold Solver | `http://localhost:8081` |

如果 `.env` 中没有配置外部 API Key，前端和基础页面仍然可以启动，GeoGebra 离线画布和 Studio 也能加载；AI 对话、图片解题、Manim 生成、GeoGebra 命令规划和 Studio 调整等能力会受限。

### 手动启动

只启动 Gateway：

```bash
npm install
cp .env.example .env
npm start
```

Windows PowerShell 可以用：

```powershell
npm install
Copy-Item .env.example .env
npm start
```

单独启动 Manim 服务：

```bash
npm run manim
```

单独启动 Timefold Solver：

```bash
npm run solver:dev
```

构建 Manim Studio 前端：

```bash
npm run build:studio
```

## 环境要求

| 组件 | 版本或说明 |
| --- | --- |
| Node.js | 建议使用当前 LTS 版本。 |
| npm | 随 Node 安装，用于 Gateway 和 Studio 构建。 |
| Python | Manim 服务要求 Python 3.12。 |
| Java | Solver 服务要求 Java 21。 |
| Maven Wrapper | `solver/mvnw.cmd` 已随仓库提供。 |

完整环境变量模板在 [.env.example](.env.example)。建议复制为 `.env` 后再填写本机密钥和端口。

## 功能依赖矩阵

| 功能 | 需要启动的服务 | 关键环境变量 | 未配置时表现 |
| --- | --- | --- | --- |
| 页面和基础 Gateway | Node Gateway | `PORT` 可选 | 可以正常访问静态页面和健康检查。 |
| AI 对话 | Node Gateway | `DEEPSEEK_API_KEY`、`DEEPSEEK_API_BASE`、`DEEPSEEK_MODEL` | 对话接口不可用或返回配置错误。 |
| 流式对话 | Node Gateway | 同 AI 对话 | 流式接口不可用或降级失败。 |
| 图片解题和 OCR | Node Gateway | `SILICONFLOW_API_KEY`、`SILICONFLOW_API_BASE`、`SILICONFLOW_VLM_MODEL`，`MINERU_API_KEY` 可选；MinerU 下载预算和冷却期可配 `MINERU_DOWNLOAD_BUDGET_MS`、`MINERU_FAILURE_COOLDOWN_MS` | 图片识别、文档解析相关能力不可用。 |
| Manim 动画 | Node Gateway、Manim 服务 | `MANIM_SERVICE_URL`、`MANIM_SERVICE_TOKEN` 可选，通常也需要 `DEEPSEEK_API_KEY` | 动画生成、渲染和 Studio 相关能力不可用。 |
| GeoGebra 动态几何 | Node Gateway、本地浏览器资源 | 离线画布和 Studio 不需要新增变量；AI 命令规划、Studio 调整复用 `DEEPSEEK_API_KEY`、`DEEPSEEK_API_BASE`、`DEEPSEEK_MODEL` | 无 Key 时画布和手写命令仍可用，主输入框生成命令、Studio AI 调整和失败修复不可用。 |
| 座位规划基础能力 | Node Gateway | 无强制外部 Key | 本地规则和基础预览可用，AI 辅助能力受限。 |
| 座位规划 AI 辅助 | Node Gateway | `DEEPSEEK_API_KEY` | 自然语言解析、AI 建议和智能预览能力受限。 |
| Timefold 求解 | Timefold Solver、Node Gateway | `TIMEFOLD_SOLVER_URL`、`TIMETABLE_SOLVER_TIMEOUT`（默认 210 秒）可选；旧 `TIMEFOLD_SOLVER_TIMEOUT` 继续兼容 | 复杂求解不可用，座位工具仍可走本地能力。 |
| 反馈邮件 | Node Gateway、SMTP 服务 | `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS`、`FEEDBACK_EMAIL_TO` | 邮件发送不可用。 |

## 服务拓扑

```text
Browser
  |
  | HTTP
  v
Node Gateway :3000
  |-- 静态页面和前端工具 -> public/
  |-- Chat/Solver API -> DeepSeek 或兼容模型服务
  |-- 图片解析能力 -> SiliconFlow / MinerU
  |-- Manim API -> manim-service :8001
  |-- GeoGebra API -> services/geogebra + public/vendor/geogebra
  |-- Timefold 求解 -> solver :8081
  `-- 反馈邮件 -> SMTP
```

Gateway 是浏览器唯一需要直接访问的本地入口。Manim、Timefold 和外部模型服务都由 Gateway 统一适配。GeoGebra 不新增独立后端进程，浏览器从 `public/vendor/geogebra/` 加载离线 HTML5 运行时，Gateway 只负责命令搜索、AI 规划、Studio 调整和失败修复。

## MinerU CDN 和跨环境部署

MinerU 云解析成功后还需要从 `cdn-mineru.openxlab.org.cn` 下载结果 zip。ICeCream 保持 MinerU 优先：能直连就使用 MinerU；如果服务器、国内外网络或 Fake-IP 环境导致 CDN 不可达，会自动进入短期冷却并降级到后续视觉识别层，不要求部署机器必须配置代理。

默认配置：

```env
MINERU_DOWNLOAD_BUDGET_MS=35000
MINERU_DOWNLOAD_RETRIES=2
MINERU_FAILURE_COOLDOWN_MS=600000
```

如果本机或服务器有可用代理，并且希望提高 MinerU CDN 命中率，可以额外配置：

```env
MINERU_DOWNLOAD_PROXY=http://127.0.0.1:7890
```

该代理只用于 MinerU 结果包下载，不影响 DeepSeek、SiliconFlow、Manim 或 GeoGebra。代理不是部署必需项；未配置代理且检测到 `198.18.x.x` 或 TLS/网络失败时，系统会快速跳过 MinerU zip 下载并继续解题或座位表 OCR。

## GeoGebra 互动课件包和 PPT

GeoGebra Studio 支持导出 GGBTool 风格的离线互动课件包。导出的 zip 包含 `index.html`、`config/ggbs.js`、课件脚本和 `lib/GeoGebra/` 离线运行时，并会携带当前题目的 timeline 轨迹演示、等比例视图和清洗后的题目文本。

在 PowerPoint 中使用时，推荐先把 zip 完整解压，然后在 PPT 里插入截图、形状按钮或文字，并给它添加指向 `index.html` 的超链接。放映时点击该对象，会在浏览器中打开可拖动、可播放的 GeoGebra 互动课件。第一版不直接生成 `.pptx`，也不要求 Office 插件。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `dev.bat --check` | 检查 Windows 本地开发环境。 |
| `dev.bat` | 一键启动本地开发环境。 |
| `npm start` | 启动 Node Gateway。 |
| `npm run dev` | 使用 `node --watch` 启动 Gateway。 |
| `npm run dev:all` | 并行启动 Gateway 和 Manim 服务。 |
| `npm run manim` | 启动 Python Manim 服务。 |
| `npm run solver:dev` | 启动 Java Timefold Solver。 |
| `npm run build:studio` | 构建 Manim Studio 前端。 |
| `npm test` | 运行 Node 测试。 |
| `npm run solver:test` | 运行 Solver 测试。 |

## API 分组

README 只列主要入口，避免把内部 job、failure、patch 等维护接口展开成清单。详细职责和拆分计划见 [PROJECT_READING_GUIDE.md](PROJECT_READING_GUIDE.md)。

### Health

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | Gateway 健康检查。 |
| `POST /api/log` | 前端运行日志上报。 |
| `GET /api/ai/status` | AI 配置状态检查。 |

### Chat

| 接口 | 用途 |
| --- | --- |
| `POST /api/message` | 旧版消息入口。 |
| `POST /api/chat` | 对话入口。 |
| `POST /api/chat/stream` | 流式对话入口。 |

### Solver

| 接口 | 用途 |
| --- | --- |
| `POST /api/solver` | 解题入口。 |
| `POST /api/solver/chat` | 解题对话入口。 |

### Manim

| 接口 | 用途 |
| --- | --- |
| `POST /api/manim` | Manim 生成入口。 |
| `POST /api/manim/agent/stream` | Manim agent 流式入口。 |
| `POST /api/manim/render` | Manim 渲染入口。 |
| `GET /api/manim/status` | Manim 服务状态。 |
| `GET /api/manim/skills` | Manim 能力描述。 |
| `GET /api/manim/jobs` | 渲染任务列表。 |

更多 Manim 内部维护接口位于 `/api/manim/*` 下，例如 job 详情、取消、失败事件回放、参考图片、补丁和布局重建。

### GeoGebra

| 接口 | 用途 |
| --- | --- |
| `GET /api/geogebra/status` | GeoGebra 离线资源、AI 配置和命令索引状态。 |
| `GET /api/geogebra/commands/search` | 搜索 GeoGebra 命令语法。 |
| `POST /api/geogebra/plan` | 根据主输入框描述生成动态几何命令计划。 |
| `POST /api/geogebra/studio/adjust` | 根据 GeoGebra Studio 当前画布、选中对象和命令历史生成调整命令。 |
| `POST /api/geogebra/repair` | 根据失败命令和画布状态生成修复命令。 |
| `POST /api/geogebra/export/courseware` | 导出包含本地 GeoGebra runtime 的离线互动课件包 zip。 |

### Tools 和 Seating

| 接口 | 用途 |
| --- | --- |
| `GET /api/tools/health` | 工具模块健康检查。 |
| `POST /api/tools/seating/arrange` | 座位安排。 |
| `POST /api/tools/seating/layout-preview` | 布局预览。 |
| `POST /api/tools/seating/suggestions` | 座位建议。 |
| `POST /api/tools/seating/export-xlsx` | 导出 Excel。 |
| `POST /api/tools/seating/parse` | 自然语言解析。 |
| `POST /api/tools/seating/parse-image` | 图片名单解析。 |
| `POST /api/tools/seating/chat` | 座位规划对话。 |

## 测试命令速查

文档改动不需要运行完整测试。代码改动建议按影响范围选择命令：

| 范围 | 命令 |
| --- | --- |
| Node 全量测试 | `npm test` |
| Gateway 模块测试 | `node --test test/gateway-modules.test.js` |
| GeoGebra 聚焦测试 | `node --test test/geogebra-courseware-export.test.js test/geogebra-studio-ui.test.js test/geogebra-command-search.test.js test/geogebra-route.test.js test/geogebra-ui-integration.test.js` |
| Seating 聚焦测试 | `node --test test/seating-arrange.test.js test/seating-arrange-route.test.js test/seating-core.test.js` |
| Manim agent 测试 | `cd manim-service && python -m unittest tests.test_agent` |
| Solver 测试 | `cd solver && .\mvnw.cmd test "-Dquarkus.http.test-port=0"` |

## 常见开发任务

| 任务 | 从哪里开始 |
| --- | --- |
| 改前端主界面 | `public/index.html`、`public/js/app.js`、`public/js/core/`。 |
| 改课堂工具前端 | `public/js/tools/`，座位规划重点看 `public/js/tools/seating-planner/` 或现有入口。 |
| 改 Gateway API | `gateway/routes/` 定义 HTTP 适配，业务逻辑放到对应 service。 |
| 改聊天能力 | `services/chat/` 和 Gateway 中对应路由。 |
| 改解题能力 | `services/solver/`、`gateway/routes/solver.js`。 |
| 改座位规划 | Node 侧看 `gateway/services/seating-*`，共享算法后续应沉到 `shared/seating/`。 |
| 改 Manim 能力 | 优先看 `manim-service/app/agent/`、`manim-service/app/services/`、`manim-service/app/runtime/`、`services/manim/`。 |
| 改 GeoGebra 能力 | 前端看 `public/js/core/geogebra-canvas.js`、`public/js/core/geogebra-studio.js`、`public/js/core/geogebra-workbench.js`，后端看 `services/geogebra/` 和 `gateway/routes/geogebra.js`。 |
| 改 Solver 服务 | `solver/src/main/java/` 下按 domain、solver、rest 边界维护。 |
| 改 Manim Studio 前端 | `src/manim-studio/`，构建后输出到 `public/js/studio/`。 |
| 改 GeoGebra Studio 前端 | `public/js/core/geogebra-studio.js`，画布底座在 `public/js/core/geogebra-canvas.js`。 |

新功能放置原则：

- 新业务 API：优先建立 `services/<domain>/`，再由 `gateway/routes/<domain>.js` 暴露 HTTP。
- 新课堂工具：前端入口放 `public/js/tools/`，后端能力放明确领域 service。
- 新共享算法：放 `shared/<domain>/`，不要从后端 import `public/`。
- 新 Manim 能力：优先放到 `manim-service/app/agent/` 或明确 adapter，不继续扩大 legacy 入口。
- 新 GeoGebra 能力：前端交互放 `public/js/core/geogebra-*` 或后续明确子目录，Studio 调整和命令规划放 `services/geogebra/`，离线运行时继续放 `public/vendor/geogebra/`。
- 新 Java 求解能力：保持 domain、solver、rest 的职责边界。

## 不要提交的内容

以下内容属于依赖、缓存、运行时目录或构建产物：

```text
node_modules/
solver/target/
uploads/
logs/
manim-service/static/
.venv/
.pip-cache/
public/js/studio/
```

提交前建议运行：

```bash
git status --short
git diff --check
```

## 维护入口

- 使用和启动入口：本文档。
- 模块化交接和深度维护：[PROJECT_READING_GUIDE.md](PROJECT_READING_GUIDE.md)。
- 环境变量模板：[.env.example](.env.example)。
- 授权协议：[LICENSE](LICENSE)。

## License

ICeCream 源码使用 MIT，见 [LICENSE](LICENSE)。`public/vendor/geogebra/` 内的 GeoGebra HTML5 离线运行时遵循 GeoGebra 自身的非商业授权，见 [public/vendor/geogebra/LICENSE-GEOGEBRA.txt](public/vendor/geogebra/LICENSE-GEOGEBRA.txt)。
