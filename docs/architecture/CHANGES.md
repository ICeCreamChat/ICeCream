# 变更操作手册

AI agent 执行常见改动的标准流程。**每个场景先读对应模块卡片（MODULES.md），再按此手册操作。**

---

## 场景索引

- [A. 新增一个前端工具](#a-新增一个前端工具)
- [B. 座位安排：新增约束类型](#b-座位安排新增约束类型)
- [C. 排课：新增约束类型](#c-排课新增约束类型)
- [D. 修改排课项目数据结构](#d-修改排课项目数据结构)
- [E. 调整 AI Prompt](#e-调整-ai-prompt)
- [F. Solver 参数调优](#f-solver-参数调优)
- [G. 修复 UI Bug](#g-修复-ui-bug)
- [H. 新增 HTTP API](#h-新增-http-api)
- [I. 升级依赖](#i-升级依赖)

---

## A. 新增一个前端工具

**等级：L1-L2（新模块走 OpenSpec 提案）**

1. 在 `public/js/tools/` 创建 `<tool-name>.js`（入口，默认导出含 `init(container)` 的对象）
2. 复杂工具建 `<tool-name>/` 子目录拆分面板
3. 在 `app-launcher.js` 的 `TOOLS_CONFIG` 注册（id/icon/title/module）
4. 后端 API：
   - `gateway/routes/tools/<tool-name>/` 建路由
   - `gateway/routes/tools.js` 挂载
   - `gateway/services/<tool-name>-*.js` 写业务逻辑
5. 样式：`public/css/<tool-name>.css` + index.html 引入
6. 测试：`test/<tool-name>-*.test.js`
7. 更新 MODULES.md 增加模块卡片

**禁止：** 在其他工具的文件里塞新工具逻辑

---

## B. 座位安排：新增约束类型

**等级：L1**

**全链路（5 处修改，缺一不可）：**

1. **解析**：`gateway/services/seating-constraints.js`
   - `DIRECT_TYPES` 加类型名
   - 解析规则（正则/AI prompt）产出该类型
2. **传递**：`gateway/services/seating-solver-bridge.js`
   - 请求构造包含新约束字段
3. **求解**：`solver/.../seating/solver/SeatingConstraintProvider.java`
   - 新增 Constraint 方法
   - `domain/SeatingConstraintConfig.java` 加配置字段
4. **降级**：`gateway/services/seating-arrange.js`
   - 本地算法 `assignLocalSeats` 尽力支持（或明确忽略并警告）
5. **测试**：
   - `test/seating-constraints-parser.test.js` 解析用例
   - Java 端 ConstraintProviderTest 用例

**验证：** `npm test` + `npm run solver:test`

---

## C. 排课：新增约束类型

**等级：L1-L2（复杂约束先开 OpenSpec 提案）**

**全链路（6 处修改）：**

1. **能力注册**：`timetable-constraints/capabilities.js` 声明能力
2. **IR 定义**：`timetable-constraints/constraint-ir.js` 定义结构
3. **解析识别**：`timetable-rule-parser.js` 或 `semantic-planning.js` 产出 IR
4. **求解传递**：`timetable-solver-bridge.js` 的 problem 构造
5. **Java 实现**：`TimetableConstraintProvider.java` + 必要的 domain 字段
6. **测试**：
   - `test/timetable-constraint-ir-137.test.js` IR 用例
   - `test/timetable-rule-parser.test.js` 解析用例
   - Java ConstraintProviderTest

**验证：** `npm test` + `npm run solver:test` + 真实浏览器快照回归（见 CLAUDE.md 缓存策略）

---

## D. 修改排课项目数据结构

**等级：L2（必须走 OpenSpec 提案）**

**风险：** projects.json 已有用户数据 + browser-test-cache 快照会失效

1. 先在 `timetable-project.js` 的 normalize 里写**向后兼容迁移**（旧数据自动升级）
2. Schema 校验同步更新
3. 检查所有读写方：Grep `loadProjects\|getProject` 找调用点
4. 快照影响评估：`data/timetable/browser-test-cache/real-school-900/` 是否需重新生成
5. 测试：`test/timetable-project-normalization.test.js` 加迁移用例

**禁止：** 直接改 Schema 不写迁移

---

## E. 调整 AI Prompt

**等级：L0-L1**

| Prompt 位置 | 影响 |
|------------|------|
| `gateway/services/timetable-ai-prompts.js` | 排课约束 AI 解析 |
| `gateway/services/seating-arrange.js` 内嵌 | 座位布局生成 |
| `gateway/services/ocr.js` 内嵌 | 名单图片提取 |
| `manim-service/app/prompts.py` | 动画代码生成 |

**流程：**
1. 只改 prompt 文本，不动解析逻辑 → L0，直接改
2. 改输出格式 → L1，同步改响应解析代码 + 测试 mock 数据
3. 跑对应模块测试（AI 调用被 mock，测的是解析健壮性）

---

## F. Solver 参数调优

**等级：L0-L1**

| 参数 | 位置 |
|------|------|
| 求解时长 | `.env` TIMETABLE_SOLVER_SPENT_LIMIT / solver application.properties |
| 算法阶段 | `solver/src/main/resources/*SolverConfig.xml` |
| 约束权重 | Java ConstraintProvider 或请求参数 |

**流程：**
1. 改 XML/properties → 跑 `test/timetable-solver-config.test.js`（有断言锁定关键配置）
2. 改权重 → 跑 solver:test + 真实数据回归
3. 注意 Gateway 超时 TIMETABLE_SOLVER_TIMEOUT 必须 > Java 端 spent limit

---

## G. 修复 UI Bug

**等级：L0**

1. 定位：前端工具 bug 先看对应 `controller*.js`（交互）或 `view*.js`（渲染）或 `state.js`（数据）
2. 修复原则：
   - 状态问题只改 state.js
   - 渲染问题只改 view
   - 不要在 view 里改 state（单向数据流）
3. 验证：对应 ui 测试 + 必要时 ui-smoke 浏览器验证

---

## H. 新增 HTTP API

**等级：L1**

1. 路由：`gateway/routes/tools/<module>/<feature>.js`
2. 业务逻辑：放 services，路由文件只做参数校验 + 调用 + 错误映射
3. 错误响应统一格式：`{success: false, error: string}`
4. 前端：对应工具的 api.js 加封装函数
5. 测试：路由级测试（起真实 Express 实例）

**禁止：** 在路由文件里写业务逻辑

---

## I. 升级依赖

**等级：L1（需用户确认）**

1. 先查用途：Grep 该包在代码中的 import
2. 看 changelog 的 breaking changes
3. 升级后跑全量 `npm test`
4. 前端 vendored 库（public/js/libs/）与 npm 无关，更新需手动替换文件

---

## 通用检查清单（每次改动后）

```
□ 只改了目标模块的文件？（跨模块 = 升级到 L1/L2）
□ 对应测试通过？
□ 新增逻辑有测试覆盖？
□ 接口变更同步了所有调用方？（Grep 确认）
□ MODULES.md 需要更新吗？（新增接口/模块时）
□ 提交信息符合规范？（Conventional Commits 三段式）
```
