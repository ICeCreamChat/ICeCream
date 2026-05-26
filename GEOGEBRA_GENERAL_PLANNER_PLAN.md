# GeoGebra 通用 Planner 改造交接文档

## 背景和目标

当前 GeoGebra 绘图能力已经具备 Studio、离线 GeoGebra runtime、命令执行、上传题目、互动课件包导出等基础能力。但目前后端仍倾向通过确定性题型模板处理部分题目，例如圆弦中点轨迹题。这种方式能解决单个例题，却不适合真实用户场景。

用户上传或输入的问题会非常多样：解析几何、函数图像、圆锥曲线、三角形、立体几何、变换、参数曲线、作图题、证明辅助图、课堂演示题等都可能出现。继续为每类题写确定性模板会导致：

- 模板数量快速膨胀，维护成本不可控。
- 题目稍微改写就可能匹配失败或生成错误图形。
- OCR 文本中的符号、LaTeX、空格和中文表达变化会让硬编码规则变脆。
- 开发重心会从“通用理解和校验”偏到“补丁式特判”。
- 成功状态和真实落图可能不一致，用户看到的是“已成功”，画布却不正确。

本次改造目标是把 GeoGebra 后端从“确定性题型模板优先”改成“通用 Planner 优先”：由 AI 进行结构化题意理解和 GeoGebra 命令规划，本地代码负责输入清洗、知识检索、命令安全校验、执行反馈和失败修复。画图正确优先，不承诺完整解题证明。

## 总体原则

- 不再新增运行时确定性题型模板。
- 不让某个具体题型拥有特殊代码路径。
- 文本归一化、事实抽取、题型分类可以保留，但只作为 Planner 的上下文，不直接生成最终 GeoGebra 命令。
- GeoGebra 命令必须经过统一校验和安全过滤。
- AI 返回必须是严格 JSON，不接受 Markdown、自然语言包裹或代码块。
- AI 返回非 JSON 时，后端自动进行一次 JSON 修复重试。
- 没有可用 AI 配置时，不要伪造“成功绘图”，应返回清晰可读的错误。
- 前端不能保留旧成功摘要误导用户；失败时应明确显示失败原因，并保留用户输入。
- Manim 不参与本轮改造。

## 目标架构

目标链路如下：

```text
题目/OCR 文本
-> 文本归一化
-> 结构化题意理解
-> 本地手册/命令索引检索
-> GeoGebra 命令计划
-> JSON 解析和修复重试
-> 命令安全校验
-> 前端执行
-> 读取画布对象和失败命令
-> 失败自动修复
```

### 1. 题目/OCR 文本

输入来源包括：

- GeoGebra Studio 右侧题目输入框。
- 上传题目图片后的 OCR 或视觉描述。
- 主输入框在 GeoGebra 模式下发来的文本。
- 后续可能加入的多页草稿或课件上下文。

输入文本需要统一清洗，但不要在清洗阶段决定最终画图方案。

### 2. 结构化题意理解

Planner 应先让 AI 输出结构化事实，例如：

- 已知对象：点、线、圆、函数、角、长度、参数、约束。
- 待构造对象：动点、轨迹、辅助线、切线、垂线、圆、函数图像等。
- 关系约束：在圆上、在轴上、垂直、平行、等长、中点、最大值、轨迹等。
- 目标：画图、演示轨迹、求坐标、展示最值位置、生成互动构造。
- 不确定项：缺失条件、OCR 不清晰、符号歧义。

结构化事实用于生成命令和前端解释，但不要将本地正则抽取的 facts 直接当作最终答案。

### 3. GeoGebra 命令计划

AI 根据结构化事实、当前画布状态、命令手册检索结果生成 GeoGebra 命令。命令计划应包含：

- 创建基础对象的命令。
- 创建约束对象的命令。
- 设置样式、标签、颜色和可见性的命令。
- 可选 viewport，用于保持几何图形等比例显示。
- 可选 demo timeline，用于轨迹或动态演示。
- 可选 followUp，用于提示用户可继续调整的方向。

### 4. 命令校验

后端在返回前统一检查：

- commands 必须是字符串数组。
- 禁止危险命令或不可控外部资源。
- 命令数量需要有上限，避免一次请求生成过大工作量。
- viewport 必须是有限数值。
- demo timeline 只允许已支持的 track 类型和安全数值路径。
- 不允许把自然语言说明混入 commands。

### 5. 前端执行

前端负责：

- 清空或保留画布，取决于用户动作是“生成图形”还是“调整当前图”。
- 顺序执行 commands。
- 执行后读取画布对象。
- 应用 viewport。
- 根据 demo timeline 播放动画。
- 收集失败命令，触发 repair。

### 6. 失败自动修复

如果某条命令失败，前端应把以下信息发回 `/api/geogebra/repair`：

- 原始题目。
- 当前画布对象。
- 已成功执行的命令历史。
- 失败命令和错误信息。
- 当前 viewport 和 selectedObjects。

后端使用同一个通用 Planner 思路生成修复命令，不要进入具体题型特判。

## 需要改的模块

### `services/geogebra/geogebra-agent.js`

目标：改成通用 Planner 编排入口。

建议调整：

- 移除或绕开 deterministic-first 的运行时路径。
- 输入阶段调用文本归一化和本地命令手册检索。
- 先构造“结构化题意理解 + 命令规划”的 Prompt。
- AI 返回后严格解析 JSON。
- JSON 解析失败时自动重试一次，重试 Prompt 应包含原始回复和解析错误。
- 第二次仍失败时返回用户可读错误，例如“GeoGebra Agent 没有返回可执行 JSON，请稍后重试或简化题目描述”。
- 对 commands、viewport、demo、facts 做统一校验。
- 保持现有 `/api/geogebra/plan`、`/repair`、`/studio/adjust`、`/studio/parse-image` 的响应兼容。

### `services/geogebra/geogebra-deterministic-plans.js`

目标：从运行时 Planner 中退场。

建议调整：

- 不再作为 `/api/geogebra/plan` 的优先路径。
- 可以保留文件作为历史参考或测试夹具，但明确标记 deprecated。
- 如果保留导出函数，应避免被生产链路调用。
- 不要继续新增题型模板。

### `services/geogebra/problem-types.js`

目标：保留通用辅助能力，不生成最终 commands。

建议保留：

- OCR/LaTeX/中文标点清洗。
- 文本归一化。
- 粗略题型分类。
- 结构化事实候选抽取。

建议删除或降级：

- 直接返回确定性绘图命令的逻辑。
- 针对某个题目硬编码最终答案的逻辑。

这些输出应作为 AI Prompt 的 context，而不是最终绘图结果。

### `services/geogebra/geogebra-prompt.js`

目标：把 Prompt 从“让模型猜命令”升级为“结构化理解 + 严格命令计划”。

必须强调：

- 只返回 JSON。
- 不输出 Markdown。
- 不输出代码块。
- 不把解释文字放在 JSON 外面。
- 命令必须能被 GeoGebra Classic 执行。
- 如果条件不足，应返回 `needsClarification: true` 和 `followUp`，不要编造图形。
- 如果是几何题，默认给出 `viewport.equalScale = true`。
- 如果需要动态演示，返回通用 `demo.timeline`，不要把演示命令混入普通 commands。

### `services/geogebra/manual-search.js`

目标：作为 Planner 的本地知识检索支持。

建议能力：

- 根据题目和候选对象搜索 GeoGebra 命令、工具和 API 说明。
- 返回紧凑片段，不要把大段手册塞进 Prompt。
- 优先覆盖点、线、圆、圆锥曲线、函数、轨迹、角度、切线、垂线、中点、参数曲线、3D 基础对象。

### `gateway/routes/geogebra.js`

目标：保持 API 兼容，同时让错误更可读。

建议调整：

- `/api/geogebra/plan` 透传通用 Planner 的成功和失败结果。
- `/api/geogebra/repair` 透传修复计划。
- `/api/geogebra/studio/adjust` 走同一 Planner，但不清空当前图。
- `/api/geogebra/studio/parse-image` 先 OCR/视觉理解，再走通用 Planner。
- 不要在 route 层写题型判断。

### `public/js/core/geogebra-studio.js`

目标：前端以“直接画图”体验为主，同时正确处理失败和修复。

建议调整：

- 生成图形失败时保留题目输入。
- 不显示旧的成功摘要。
- 不把旧 OCR、旧结果、旧错误持久化到新会话。
- 如果后端返回 `needsClarification`，显示补充问题，而不是清空画布。
- 执行命令后对象数量仍为 0 时，显示“命令已返回但未落图”。
- 调整当前图时不清空画布。
- 生成图形和上传题目自动绘图时，应清空旧画布并停止当前演示。
- demo timeline 播放仍由前端统一处理。

### `public/js/core/geogebra-canvas.js`

目标：保持执行底座稳定。

建议确认：

- `executeCommand` 和批量命令执行能返回每条命令的成功/失败信息。
- `readCanvas` 能读取对象列表、类型、定义和值。
- viewport 的 `equalScale` 能正确应用，圆不被拉伸。
- timeline 演示使用 `SetValue`、`SetTrace`、`requestAnimationFrame`，结束后保留轨迹。

### 测试文件

需要更新或新增：

- `test/geogebra-route.test.js`
- `test/geogebra-problem-types.test.js`
- `test/geogebra-ui-integration.test.js`
- `test/geogebra-studio-ui.test.js`
- `test/geogebra-agent-step.test.js`
- `test/geogebra-command-search.test.js`
- `test/geogebra-courseware-export.test.js`

重点是删除“某个题必须命中确定性模板”的测试思路，改成验证通用 Planner 的契约、错误处理、JSON 修复、命令校验和前端行为。

## 输出契约

Planner 成功时建议返回：

```json
{
  "success": true,
  "intent": "geogebra",
  "data": {
    "summary": "简短说明本次画了什么",
    "perspective": "geometry",
    "facts": {
      "objects": [],
      "constraints": [],
      "goals": [],
      "uncertainties": []
    },
    "commands": [
      "A = (0, 0)"
    ],
    "viewport": {
      "xmin": -6,
      "ymin": -4,
      "xmax": 6,
      "ymax": 6,
      "equalScale": true
    },
    "demo": {
      "type": "timeline",
      "autoPlay": false,
      "clearBeforePlay": true,
      "preserveAfterFinish": true,
      "durationMs": 6000,
      "tracks": []
    },
    "followUp": "",
    "studioNotes": ""
  }
}
```

Planner 需要澄清时建议返回：

```json
{
  "success": true,
  "intent": "geogebra",
  "data": {
    "needsClarification": true,
    "summary": "题目条件不足，暂不生成完整图形",
    "commands": [],
    "followUp": "请补充点 P 的约束范围或目标对象。"
  }
}
```

Planner 失败时建议返回：

```json
{
  "success": false,
  "error": "GeoGebra Agent 没有返回可执行 JSON，请稍后重试或简化题目描述。"
}
```

## JSON 修复重试

如果 AI 第一次返回不是合法 JSON：

1. 后端记录原始回复。
2. 构造修复 Prompt，要求模型只把上一条回复改写成符合契约的 JSON。
3. 修复 Prompt 中包含解析错误。
4. 只重试一次。
5. 第二次失败后返回可读错误，不要继续无限重试。

修复 Prompt 示例方向：

```text
上一条回复不是合法 JSON，解析错误如下：
<parse error>

请只输出一个符合 ICeCream GeoGebra Planner 契约的 JSON 对象。
不要输出 Markdown。
不要解释。
不要使用代码块。

上一条原始回复：
<raw response>
```

## 前端体验要求

默认体验应保持简单：

- 用户输入题目后点击“生成图形”。
- 上传图片后自动解析并绘图。
- 绘图失败时显示当前失败原因。
- 用户可以修改题目后重新绘图。
- 用户可以点击“调整当前图”对当前画布做增量修改。
- 高级工具继续保留对象、命令、历史、参考和草稿，但不要干扰默认流程。

失败时不要出现这些问题：

- 右侧显示“已成功”，但画布没有对象。
- 新打开 Studio 仍看到上次题目或旧 OCR 内容。
- 后端失败时前端清空用户输入。
- AI 返回非 JSON 时只显示生硬的内部错误。
- 旧结果摘要覆盖本次失败状态。

## 测试计划

### 后端重点测试

- AI 返回合法 JSON 时，Planner 能返回 commands、viewport、demo。
- AI 第一次返回非 JSON 时，会进行一次修复重试。
- 修复后合法 JSON 能被正常返回。
- 两次都失败时返回可读错误。
- 没有 DeepSeek 或兼容 AI 配置时，不走伪成功，不返回硬编码图形。
- 命令安全过滤能拦截危险命令。
- `problem-types` 只做归一化、分类和 facts 候选，不直接生成最终 commands。
- `/api/geogebra/plan`、`/repair`、`/studio/adjust`、`/studio/parse-image` 响应结构兼容现有前端。

### 前端重点测试

- “生成图形”调用 `/api/geogebra/plan` 并执行返回 commands。
- “调整当前图”调用 `/api/geogebra/studio/adjust`，不清空当前画布。
- 上传题目成功后自动执行 commands。
- 后端返回非成功时不显示旧成功摘要。
- 命令返回但落图对象数为 0 时显示落图失败提示。
- demo timeline 仍可播放、暂停、清除轨迹。
- 导出 PNG、导出 `.ggb`、导出互动课件包不被破坏。

### 建议运行命令

```powershell
node --test test/geogebra-route.test.js test/geogebra-problem-types.test.js
node --test test/geogebra-ui-integration.test.js test/geogebra-studio-ui.test.js
node --test test/geogebra-courseware-export.test.js
npm test
```

## 验收标准

- GeoGebra 规划链路不再依赖运行时确定性题型模板。
- 用户稍微改变题目表述时，不再因为模板没覆盖而直接失败。
- AI 返回非 JSON 时，后端会自动修复一次。
- AI 两次失败或配置缺失时，前端显示清晰错误，不显示旧成功状态。
- `/api/geogebra/plan` 能处理多种题目类型的通用绘图请求。
- 命令执行失败时能进入 repair 流程。
- 已有 Studio 默认体验保持“输入或上传 -> 直接画图”。
- 轨迹 timeline、等比例 viewport、互动课件包导出继续可用。
- Manim 工作台不受影响。

## 假设

- 通用绘图能力依赖 DeepSeek 或兼容 OpenAI 风格的 AI 配置。
- 没有 AI 配置时，系统可以提供手动命令和导入 `.ggb` 能力，但不承诺自动理解任意题目并绘图。
- 本轮不做桌面客户端。
- 本轮不做 Office Add-in。
- 本轮不直接生成 `.pptx`。
- 本轮不新增 Python、Java、数据库或独立 GeoGebra 服务。
- GeoGebra vendored runtime 继续遵循单独授权，ICeCream 自有代码仍按 MIT。

## Claude 执行提醒

- 请先改测试，再改实现。
- 不要继续新增题型特判。
- 不要在 route 层写题型逻辑。
- 不要把确定性模板包装成“通用 Planner”。
- 每次失败都要让错误对用户可读。
- 保留现有 GeoGebra Studio、timeline 演示、等比例视图和 courseware export 行为。
- 对外响应结构尽量兼容现有前端，避免一次改造牵连过大。
