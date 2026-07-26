# CLAUDE.md

本仓库的 AI 协作规则。Claude Code、Codex 等 AI agent 在本仓库工作时遵循此文件。

## 何时触发 OpenSpec 流程

请求涉及以下情形时，先打开 `./OpenSpec/AGENTS.md`，按 spec-driven 流程开 change 提案，**经我（用户）审批后再动手**：

- 新能力 / 新接口 / 新模块
- 跨模块的重构、抽象重塑、依赖反转
- 数据模型、接口契约的破坏性变更
- 安全策略、认证机制、限流策略调整
- 大规模性能优化（影响行为）

可以**跳过提案直接动手**的：

- bug 修复（恢复原本预期行为）
- 拼写、注释、格式化
- 配置项调整、依赖版本升级（非破坏性）
- 已有行为的测试补充

不确定走哪条时，倾向开提案。

## Superpowers 执行增强边界

如果当前 AI agent 安装了 Superpowers，可把它作为执行增强层使用，但**不替代 OpenSpec**：

- OpenSpec 仍是本仓库新能力、跨模块重构、破坏性变更、安全 / 认证 / 限流 / 性能策略变更的唯一项目级提案、审批和归档流程。
- Superpowers 的 `brainstorming` 可用于 OpenSpec proposal 前的需求澄清与方案收敛。
- Superpowers 的 `writing-plans` 可用于把已批准的 proposal / design 细化成 `OpenSpec/changes/<id>/tasks.md` 中的可执行任务。
- Superpowers 的 `test-driven-development` 优先用于高风险业务逻辑、bug 复现修复、状态机、认证、扣费、支付、安全策略等变更；低风险文案、样式、配置微调不强制 TDD。
- Superpowers 的 `systematic-debugging`、`verification-before-completion`、`requesting-code-review` 可用于实施和交付前自检，但不能绕过本文件的验证策略和用户确认边界。
- 如 Superpowers 流程与本文件、`OpenSpec/AGENTS.md` 或用户明确指令冲突，优先遵循本仓库规则和用户指令。

## 工作风格与方法

### 基本纪律

- **证据优先**：关键判断基于代码、配置、日志、文档、命令输出和可复现现象，不基于猜测。
- **中文沟通**：面向用户的进度、计划、交付说明和风险提示默认使用中文。
- **不假装验证**：没跑过的测试、没打开过的页面、没确认过的现象，不能写成已验证。
- **规则服务于交付**：低风险小改不要过度仪式化；高风险改动必须先把范围、风险和验证讲清楚。

### 重要：先理解再动键盘

任何非琐碎任务，尤其涉及复杂系统（认证链路、状态机、并发扣费、UI 交互），**思考在前，编码在后**。

### 任务分级

| 级别 | 适用场景 | 执行要求 |
|---|---|---|
| L0 | bug 修复、文案 / 样式 / 配置微调、单文件小改 | 可直接执行并验证，交付时说明改动和结果 |
| L1 | 多文件联动、中等功能开发、局部重构 | 先收集上下文，给出简要计划，再实施和验证 |
| L2 | 新模块、跨模块重构、数据库 / 权限 / 安全 / 性能策略、核心流程调整 | 走 OpenSpec 或等价审批流程，用户确认后再实施 |

### 流程

1. **彻底分析** — 改动前读懂相关代码、调用链、边界条件。
2. **映射依赖** — 找出所有调用方、副作用、潜在回归点。
3. **澄清需求** — 任何含糊、歧义、可多解读处，**停下来问**。不假设、不猜测。
4. **完整设计** — 在脑里跑通整个方案。
5. **提出计划** — 写代码前先把策略清晰说出来。
6. **谨慎实施** — 按已认可的计划推进，逐步落地。
7. **不偏离计划** — 不为了快速修复绕过已确认的方向。

### 绝对禁止

- 没搞清楚根因就反应式改代码。
- 修一个 bug 引入新的 bug（打转）。
- 实施过程中频繁切换方案。
- "快速修复"破坏其他逻辑。
- 跳过分析直接写代码。

### 如果卡住

1. **停下** — 不要继续盲目尝试。
2. **后退** — 重新审视整个系统。
3. **加日志** — 必要时（如调试运行时行为）插入日志辅助理解，而不是猜。后端用 `kit.Logger` (zap)，前端调试可用 `console.log` 但生产代码须清理。
4. **问我** — 请用户澄清上下文或决策点。
5. **重新设计** — 基于新理解重做方案。

同类方案连续失败 2 次后，应暂停叠补丁，回到根因分析；连续失败 3 次仍无法确认方向时，必须把现象、已排除项和下一步选择说明给用户。

10 分钟的前期分析胜过 60 分钟的打转。

### 用户确认边界

默认可直接执行：

- 读取、检索、比较、总结。
- 用户已明确要求的低风险代码或文档修改。
- 测试、构建、格式化、状态查看。
- `git status`、`git diff`、`git log`、`git add`。

必须先确认：

- `git commit`（除非用户明确说提交）、`git push`、`git reset`、`git rebase`、force 系列操作。
- 删除核心文件、批量删除、破坏性移动。
- 引入新依赖、改数据库 Schema、改认证 / 权限 / 安全策略。
- 影响生产、真实数据、外部服务或付费资源的操作。
- 实施中需要明显扩大范围、改变已确认方案或牺牲既有行为。

### 验证策略

| 改动类型 | 基础验证 |
|---|---|
| 纯逻辑修改 | 单元测试 / 类型检查 |
| 接口或 service | 单元测试、集成路径或接口冒烟 |
| 前端交互 | 构建检查 + 关键路径验证 |
| 图表、地图、canvas、复杂可视化 | 真实浏览器或 Playwright 验证，并检查控制台关键错误 |
| 数据库变更 | 迁移验证、读写验证、回滚影响评估 |
| 配置 / 构建 | 构建、启动或配置解析验证 |

### 排课真实数据浏览器缓存

- 日常 `dev.bat` 使用 `data/timetable/projects.json` 持久化当前排课项目；重启服务或刷新浏览器不得要求重新导入和求解。
- 可复用的真实学校验收快照位于 `data/timetable/browser-test-cache/real-school-900/`，当前基线为 30 个班、62 位教师、360 条任课计划、900/900 已排、0 硬冲突。
- 真实浏览器回归默认把该快照复制到新的隔离 `TIMETABLE_DATA_DIR` 后测试，禁止直接修改快照，也不要重复执行 Excel 导入和 180 秒求解。
- 只有专门验证导入链路、求解链路，或项目 Schema / 求解规则变化使快照失效时，才重新生成并更新缓存；更新后重新核对课时、硬冲突和发布校验。

验证失败时，交付或中途说明必须包含失败现象、复现方式、初步原因和下一步策略。

## 提交风格

公开仓库提交信息统一使用英文，采用 Conventional Commits + 三段式正文：

```
<type>(<optional scope>): <short English summary>

What changed:
- <what changed and why>

Impact:
- <affected files / modules / APIs / behavior>

Validation:
- <tests, builds, or manual checks performed>
```

`<type>` 取值：`feat` / `fix` / `refactor` / `chore` / `docs` / `test` / `style` / `perf`。

公开提交标题和正文不得提及内部协作文件、内部规划目录、AI 工具、提示词或本地参考仓库；这些信息只保留在本地规则、OpenSpec 和私有 exclude 中。

**不自动提交** — 仅在用户明确说"提交"或等价指令时才创建 commit。

## 工具偏好

- Shell 用 Unix 语法（仓库在 Windows 但 shell 是 bash）：路径用 `/`，`/dev/null` 而非 `NUL`。
- 项目内文件搜索默认用 Glob，跨项目 / 全盘定位用 everything-search。
- 内容搜索用 Grep，读文件用 Read，**禁止**用 `find` / `grep` / `cat` / `sed`。
- 代码编辑（Go / Vue / TypeScript）优先用 Serena 的符号级工具（`find_symbol` / `replace_symbol_body` / `rename_symbol` / `insert_after_symbol` 等），尤其针对大文件与跨文件重命名；非代码文件（md / yaml / json / 配置）、小颗粒度文本调整、新建文件用 Edit / Write。
- Serena 使用前确认项目已 `activate_project` 并完成 onboarding；LSP 异常时降级回 Edit。
- 后端结构化日志统一用 `kit.Logger` (zap)，不要 `fmt.Println`。

## 引用 OpenSpec

详细的 spec-driven 流程、change 文件模板、命名规则、双语策略、版本巡航等见 [`./OpenSpec/AGENTS.md`](./OpenSpec/AGENTS.md)。

项目领域知识、技术栈、架构分层、业务概念、前后端约定见 [`./OpenSpec/project.md`](./OpenSpec/project.md)。

项目当前缺什么、要做什么、优先级与状态见 [`./OpenSpec/roadmap.md`](./OpenSpec/roadmap.md)。
