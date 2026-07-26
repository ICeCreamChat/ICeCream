# ICeCream 系统架构

## 概览

ICeCream 是一个教育工具集平台，整合 AI 聊天、智能排课、座位安排和数学动画可视化。

```
┌─────────────────────────────────────────────────────────────┐
│                      浏览器 (Browser)                         │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────┐     │
│  │ AI Chat UI │  │ Seating Tool │  │ Timetable Tool  │     │
│  └────────────┘  └──────────────┘  └─────────────────┘     │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP/WebSocket
┌──────────────────────▼──────────────────────────────────────┐
│              Gateway (Node.js + Express)                     │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ Chat Handler │  │ Seating Svc  │  │ Timetable Svc   │  │
│  │ (DeepSeek)   │  │              │  │                 │  │
│  └──────────────┘  └───────┬──────┘  └────────┬────────┘  │
└────────────────────────────┼─────────────────┼─────────────┘
                             │ HTTP           │ HTTP
              ┌──────────────▼──────┐  ┌──────▼──────────┐
              │ Timefold Solver     │  │ Manim Service   │
              │ (Java/Quarkus)      │  │ (Python/FastAPI)│
              │ - Seating optimizer │  │ - Math animation│
              │ - Timetable solver  │  │ - AI agent      │
              └─────────────────────┘  └─────────────────┘
```

## 技术栈

| 层级 | 技术 | 用途 |
|------|------|------|
| 前端 | Vanilla JS + CSS（例外：Manim Studio 画布用 React，经 `npm run build:studio` esbuild 打包） | 工具 UI |
| 网关 | Node.js 24 + Express | HTTP API、路由、业务逻辑 |
| 求解器 | Java 21 + Quarkus + Timefold | 约束优化求解 |
| 动画服务 | Python 3.12 + FastAPI + Manim | 数学可视化 |
| AI 模型 | DeepSeek API | 聊天、约束解析、OCR 提取 |

## 核心模块

### 1. Gateway (`gateway/`)
**职责：** HTTP 服务、路由分发、业务逻辑编排

**子模块：**
- `server.js` - 启动入口（监听端口、优雅关闭）
- `app.js` - Express 应用组装（中间件 + 路由注册）
- `config/` - 环境配置（environment.js 读 PORT 等，paths.js 目录约定）
- `routes/` - 路由层（index.js 统一挂载，按工具分组）
- `services/` - 业务逻辑（seating-*, timetable-*）
- `middleware/` - 中间件（intent-router, core 限流, error-handler）

**对外接口（挂载点见 routes/index.js）：**
- `POST /api/chat` - AI 聊天
- `/api/tools/seating/*` - 座位安排 API
- `/api/tools/timetable/*` - 排课 API
- `/api/manim/*`、`/api/geogebra/*`、`/api/ai/*` - 其他工具
- `GET /` - 静态文件服务（public/）

### 2. Seating Module (座位安排)
**职责：** 智能座位布局生成与学生分配

**文件分布：**
- `gateway/services/seating-*.js` - 后端逻辑（10 个文件）
- `public/js/tools/seating-planner.js` + `seating-planner/` - 前端 UI
- `shared/seating/` - 前后端共享逻辑
- `solver/src/main/java/com/icecream/seating/` - 约束求解器

**核心流程：**
```
用户输入需求 → AI 解析 → 生成布局 → Timefold 优化 → 返回座位表
```

**稳定接口：**
- `POST /api/tools/seating/arrange` - 一步完成排座
- `POST /api/tools/seating/layout-preview` - 仅生成布局

### 3. Timetable Module (排课)
**职责：** 学校课程表自动编排

**文件分布：**
- `gateway/services/timetable-*.js` - 后端逻辑（28 个文件）
- `gateway/services/timetable-constraints/` - 约束解析子系统（12 个文件）
- `gateway/services/timetable-agent/` - Agent 编排子系统（core/planner/state/tools + skills/ 六个技能）
- `public/js/tools/timetable-planner.js` + `timetable/` - 前端 UI
- `solver/src/main/java/com/icecream/timetable/` - 排课求解器

**子系统边界：**
- **约束解析** (`timetable-constraints/`) - 自然语言 → IR
- **求解器桥接** (`timetable-solver-bridge.js`) - Node ↔ Java HTTP
- **项目管理** (`timetable-project.js`, `timetable-store.js`) - 数据持久化
- **冲突诊断** (`timetable-conflicts.js`, `timetable-diagnostics.js`) - 验证与修复
- **UI 控制器** (`public/js/tools/timetable/controller.js`) - 前端状态机

**稳定接口（前缀 /api/tools/timetable）：**
- `GET /bootstrap` - 项目与配置初始化加载
- `POST /project` - 保存项目
- `POST /roster/preview` + `POST /roster/import` - Excel 任课导入
- `POST /rules/parse` - 自然语言约束解析
- `POST /schedule/run` - 触发求解（异步任务）
- `GET /schedule/jobs/:jobId` - 轮询求解进度
- `POST /schedule/adjust` - 手动微调
- `POST /schedule/publish` - 发布课表
- 完整清单见 gateway/routes/timetable.js

### 4. Solver Service (`solver/`)
**职责：** 约束优化求解（独立 Java 进程）

**启动方式：** `npm run solver:dev` 或 `dev.bat`

**对外接口（异步任务模式，base http://127.0.0.1:8081）：**
- `POST /seating-solutions` 创建任务 → `GET /seating-solutions/{jobId}/status` 轮询 → `GET /seating-solutions/{jobId}` 取结果
- `POST /timetable-solutions` 同上模式
- `GET /{module}-solutions/health` - 健康检查

**关键文件：**
- `solver/src/main/java/com/icecream/seating/solver/SeatingConstraintProvider.java`
- `solver/src/main/java/com/icecream/timetable/solver/TimetableConstraintProvider.java`
- `solver/src/main/resources/*SolverConfig.xml` - Timefold 配置

### 5. Manim Service (`manim-service/`)
**职责：** 数学动画生成（独立 Python 进程）

**启动方式：** `npm run manim`（即 `scripts/run-manim.js` 起 `python main.py`）

**对外接口：**
- WebSocket `/ws/chat` - 对话式动画生成与实时渲染进度
- 具体 HTTP 端点见 manim-service/app/legacy_main.py 与 app/api/

## 数据流向

### 排课典型流程
```
1. 用户上传 Excel → timetable-import.js 解析
2. 项目保存到 data/timetable/projects.json
3. 用户添加自然语言约束 → timetable-rule-parser.js 解析
4. 触发求解 → timetable-solver-bridge.js 调用 Java solver
5. solver 返回课表 → timetable-conflicts.js 验证
6. 前端展示网格 → 用户手动微调 → timetable-adjustment.js
7. 发布 → timetable-publication.js 导出
```

### 座位安排典型流程
```
1. 用户粘贴名单 → seating-roster.js 解析
2. 用户描述需求 → seating-arrange.js 调用 AI
3. AI 返回布局规格 → 本地算法生成座位矩阵
4. 调用 Timefold solver 优化 → seating-solver-bridge.js
5. 返回最终座位表 → 前端可视化
```

## 依赖关系规则

**允许的依赖方向：**
```
Frontend UI → Gateway Routes → Gateway Services → Solver/Manim
                            ↘ Shared ↗
```

**禁止：**
- ❌ Solver 不得调用 Gateway
- ❌ Frontend 不得直接调用 Solver（必须经 Gateway）
- ❌ Seating 与 Timetable 模块不得互相引用（通过 shared/ 共享通用逻辑）

## 测试入口

| 范围 | 命令 | 说明 |
|------|------|------|
| 全量 Node 测试 | `npm test` | test/*.js 全部用例 |
| Solver 测试 | `npm run solver:test` | Java 单元测试 |
| 排课 UI 冒烟 | `npm run test:timetable:ui-smoke` | Playwright 浏览器测试 |
| 座位 UI 冒烟 | 手动：`npm start` 后访问 `/` | 暂无自动化 |

## 启动顺序

**开发环境（完整功能）：**
```bash
# 方式 1：一键启动（推荐）
dev.bat

# 方式 2：分别启动
npm start               # Gateway (3000)
npm run solver:dev      # Solver (8081)
npm run manim           # Manim (8001)
```

**仅测试 Gateway：**
```bash
npm start  # Solver 和 Manim 离线时，相关功能降级
```

## 配置文件

| 文件 | 用途 |
|------|------|
| `.env` | 运行时配置（API keys, URLs） |
| `solver/src/main/resources/application.properties` | Quarkus 配置 |
| `manim-service/app/config.py` | Manim 服务配置 |
| `data/timetable/projects.json` | 排课项目持久化 |

## 端口分配

| 服务 | 端口 | 环境变量 |
|------|------|---------|
| Gateway | 3000 | PORT |
| Solver | 8081 | solver application.properties |
| Manim | 8001 | MANIM_SERVICE_PORT |

---

**下一步阅读：**
- [模块清单](./MODULES.md) - 每个模块的详细职责和接口
- [AI 协作规则](../../CLAUDE.md) - AI agent 工作流程
- [变更指南](./CHANGES.md) - 常见改动场景的操作手册
