# 智能排课「智能约束」完整重构方案

## 1. 重构目标

当前智能约束已经具备后端接口、约束解析、自动扫描、修复建议、Agent 会话和本地兜底能力，但整体体验仍然偏工程化，小白用户不知道该先做什么、AI 正在做什么、哪些约束能直接用、哪些需要确认、为什么排不出来。

本次重构目标不是简单美化界面，而是把智能约束重构为一个「小白可用、AI 主导、人可确认、本地算法兜底」的完整排课工作流。

最终用户应该只需要完成三件事：

1. 导入基础排课数据。
2. 用自然语言说清楚排课要求。
3. 按 AI 给出的步骤确认、修正、生成课表。

系统需要替用户完成：

1. 自动检查数据是否完整。
2. 自动理解自然语言约束。
3. 自动识别冲突、缺失、歧义、不可执行要求。
4. 自动把要求转换成标准约束。
5. 自动生成求解计划。
6. 自动调用 Timefold 或本地算法生成候选课表。
7. 自动解释失败原因和修改建议。
8. 在高风险写入前要求用户确认。

## 2. 现在的问题

### 2.1 产品体验问题

现在的智能约束入口对小白不友好，主要问题是：

1. 用户不知道「智能约束」到底能做什么。
2. 用户不知道应该先导入数据，还是先写规则。
3. 约束解析结果不够直观，用户很难判断 AI 理解得对不对。
4. 自动扫描、修复建议、规则复核、Agent 对话之间关系不清楚。
5. AI 给出的动作没有形成连续流程，用户感知不到“AI 正在主导排课”。
6. 高置信约束、待确认约束、失败约束、冲突约束没有被清晰分区。
7. AI 解析失败后虽然有本地兜底，但界面上容易表现成“AI 不会”。
8. 生成课表前缺少明确的求解计划预览。
9. 求解失败后的诊断不够像“下一步引导”，更像错误提示。

### 2.2 前端工程问题

现在前端排课模块已经拆出 `controller`、`view`、`state`、`api`、`smart helper` 等文件，但核心交互仍然存在明显问题：

1. 很多操作会触发整页 `render()`。
2. 智能约束扫描过程会多次刷新完整界面。
3. Agent 消息、规则面板、课表网格、弹窗状态混在同一个大控制器里。
4. 小改动会影响大面积 DOM，导致调试时明显卡顿。
5. 缺少局部渲染边界，课表网格不应该因为 Agent 输入框变化而重绘。
6. 图标重建、弹窗刷新、规则列表刷新可能被重复执行。
7. 交互状态没有形成清晰的状态机，后续维护成本会越来越高。

### 2.3 后端智能问题

后端已经有 `timetable-agent`、`constraint-skill`、`data-prep-skill`、`solve-plan-skill`、`solve-skill`，方向是对的，但还不够“智能主导”：

1. Agent 意图分类仍以正则关键词为主。
2. skill 之间更像流程串联，不是真正的 Planner 调度。
3. AI 解析约束后，没有形成稳定的可解释约束 DSL。
4. 约束冲突、优先级、软硬约束权重还不够体系化。
5. Timefold 与本地算法之间更像“并列候选”，不是由 Agent 根据情况选择策略。
6. 失败诊断还没有自动给出“可一键执行的调整方案”。
7. 约束应用后仍需要正式规则入口落地，体验不够闭环。

## 3. 新的产品定位

智能约束不应该是一个独立小功能，而应该是智能排课的核心入口。

建议把当前「智能约束」重构为：

> AI 排课助手：用自然语言收集要求，自动转换约束，检查冲突，并生成可执行课表。

它在界面上应该表现为一个完整的向导，而不是一个工具按钮。

新的智能约束页面分为五个区：

1. 任务进度区
2. 自然语言输入区
3. AI 理解结果区
4. 约束确认区
5. 求解与诊断区

## 4. 小白用户的新流程

### 4.1 第一步：数据体检

用户进入智能约束后，系统首先自动检查数据，而不是让用户直接写规则。

界面提示：

```text
我先帮你检查排课数据，确认班级、教师、课程、课时、可排时间是否完整。
```

数据体检结果分为：

1. 可以继续
2. 缺少关键数据
3. 存在风险但可以继续
4. 当前不能排课

示例展示：

```text
已识别：
- 12 个班级
- 38 位教师
- 9 门课程
- 540 节周课时
- 周一至周五，每天 7 节

需要补充：
- 初一(3)班数学教师缺失
- 体育课未设置每周课时
```

### 4.2 第二步：自然语言填写要求

用户不需要理解什么是硬约束、软约束，只需要像聊天一样输入：

```text
张老师周一上午不要排课，数学尽量排上午，体育不要排第一节，班主任的课尽量不要连续三天都在下午。
```

输入区需要给出小白示例：

1. 谁什么时候不能上课。
2. 哪门课尽量排在什么时间。
3. 哪些课程不能连堂。
4. 哪些老师不能一天太多课。
5. 哪些班级需要上午优先。

### 4.3 第三步：AI 理解结果

AI 不能只返回一段文字，必须把理解结果拆成结构化卡片。

每条约束显示：

1. 原始表达
2. AI 理解
3. 约束类型
4. 作用对象
5. 强度
6. 置信度
7. 是否需要确认

示例：

```text
原话：张老师周一上午不要排课
AI 理解：张老师在周一第 1-4 节不可排课
类型：教师不可用
强度：硬约束
置信度：高
状态：可确认
```

### 4.4 第四步：约束分区确认

约束确认区必须分为四栏：

1. 可直接应用
2. 需要确认
3. 存在冲突
4. 暂不支持

不要把所有解析结果混在一个列表里。

#### 可直接应用

高置信、对象明确、时间明确、无冲突。

操作：

```text
全部应用
逐条应用
查看详情
```

#### 需要确认

对象可能有多个匹配，或时间表达不精确。

示例：

```text
你说的“王老师”可能是：
- 王建国：数学
- 王丽：英语
请选择具体教师。
```

#### 存在冲突

约束之间互相矛盾，或与课时容量冲突。

示例：

```text
冲突：
张老师周一全天不可排课，但张老师本周课时较多，剩余时间可能无法完成。
建议：
- 放宽为周一上午不可排
- 或允许周五第 7 节排课
```

#### 暂不支持

当前系统无法落地的自然语言要求。

示例：

```text
“让年轻老师多上公开课”暂时无法转换为排课约束。
可以改成：指定教师每周至少安排 1 节公开课时段。
```

### 4.5 第五步：生成求解计划

在真正排课前，AI 必须给出求解计划。

计划包含：

1. 使用哪些硬约束。
2. 使用哪些软约束。
3. 哪些约束权重最高。
4. 是否启用 Timefold。
5. 是否保留本地算法兜底。
6. 预计风险。

示例：

```text
本次求解计划：
- 先满足教师不可用、班级同一时间只能上一门课、教师同一时间只能上一节课。
- 再优化数学上午优先、体育避开第一节、教师课时均衡。
- 优先尝试 Timefold。
- 如果 Timefold 不可用，使用本地确定性算法生成兜底方案。
```

### 4.6 第六步：候选方案对比

求解结果不要只显示一个课表，至少显示候选方案对比：

1. 推荐方案
2. 本地兜底方案
3. Timefold 方案
4. 上一次方案

每个方案显示：

1. 硬冲突数量
2. 软约束得分
3. 教师满意度
4. 班级均衡度
5. 规则满足率
6. 是否可保存

### 4.7 第七步：失败诊断

如果排不出来，不能只提示失败。

必须显示：

1. 最可能失败原因
2. 哪些约束导致失败
3. 可以放宽哪些规则
4. 一键尝试的方案

示例：

```text
排课失败的主要原因：
张老师、李老师、王老师都限制了周一上午不可排，但数学课又要求尽量上午，上午容量不足。

建议尝试：
1. 将“数学必须上午”改成“数学优先上午”
2. 允许周二第 6 节安排数学
3. 只保留毕业班数学上午优先
```

## 5. 前端重构方案

### 5.1 页面结构重构

建议将智能约束从普通弹窗改为独立工作台区域。

新的前端结构：

```text
public/js/tools/timetable/
  agent/
    agent-api.js
    agent-state.js
    agent-controller.js
    agent-view.js
    agent-events.js
  constraints/
    constraint-input.js
    constraint-parser-view.js
    constraint-review-panel.js
    constraint-conflict-panel.js
    constraint-fix-panel.js
  solve/
    solve-plan-panel.js
    solution-compare-panel.js
    diagnosis-panel.js
  shared/
    render-scheduler.js
    dom-cache.js
    ui-state-machine.js
```

当前 `controller.js` 不应该继续膨胀。智能约束相关逻辑要从主 controller 中抽离。

### 5.2 局部渲染边界

必须拆出以下局部渲染区域：

1. `renderAgentPanel()`
2. `renderConstraintInput()`
3. `renderConstraintReview()`
4. `renderSolvePlan()`
5. `renderSolutionCompare()`
6. `renderDiagnosis()`
7. `renderTimetableGrid()`

Agent 输入框变化不能重绘课表网格。

约束解析结果变化不能重绘整个页面。

课表网格刷新必须只在课表数据变化时发生。

### 5.3 渲染调度

新增统一渲染调度器：

```js
requestRender('agent')
requestRender('constraints')
requestRender('grid')
requestRender('diagnosis')
```

内部使用微任务或 `requestAnimationFrame` 合并重复渲染，避免短时间内多次刷新。

禁止在智能约束流程里频繁直接调用全量 `this.render()`。

### 5.4 状态机

前端智能约束状态必须改成状态机。

建议状态：

```text
idle
checking_data
data_need_fix
ready_for_constraints
parsing_constraints
reviewing_constraints
waiting_user_confirmation
building_solve_plan
waiting_solve_approval
solving
solution_review
diagnosing
finished
failed
```

每个状态对应：

1. 当前主按钮文案。
2. 是否允许输入。
3. 是否允许应用约束。
4. 是否允许开始求解。
5. 是否显示诊断。

### 5.5 小白 UI 文案

按钮不要写工程词。

推荐替换：

```text
parse constraints -> 帮我理解这些要求
scan -> 检查有没有问题
generate fix -> 给我修改建议
apply rules -> 应用这些规则
execute solve -> 开始生成课表
diagnose -> 看看为什么排不出来
publish -> 保存为正式课表
```

### 5.6 视觉层级

智能约束工作台建议采用左中右结构：

```text
左侧：步骤进度
中间：当前操作区
右侧：AI 理解与风险提示
```

小屏幕下改为上下结构。

不要使用过多卡片嵌套。

每一步只突出一个主操作。

## 6. 后端重构方案

### 6.1 Agent 从正则分类升级为 Planner

当前 `classifyIntent` 可以保留为兜底，但主流程应该升级为 LLM Planner。

Planner 输入：

1. 当前项目摘要
2. 当前 agent 阶段
3. 用户消息
4. 已有约束
5. 数据体检结果
6. 可用工具列表

Planner 输出：

```json
{
  "intent": "constraint_review",
  "nextTool": "parse_constraints",
  "reason": "用户正在描述教师不可用时间",
  "requiresApproval": false,
  "userVisibleSummary": "我会先把这些话转换成排课规则草稿。"
}
```

### 6.2 工具白名单

Agent 只能调用白名单工具。

建议工具：

```text
project.validate
project.audit
constraints.parse
constraints.normalize
constraints.detect_conflicts
constraints.apply_draft
solve.plan
solve.local
solve.timefold
solution.score
solution.compare
solution.diagnose
solution.save
```

每个工具必须返回结构化结果，不能只返回自然语言。

### 6.3 约束 DSL

自然语言约束必须统一转换为内部 DSL。

建议结构：

```json
{
  "id": "rule_xxx",
  "sourceText": "张老师周一上午不要排课",
  "type": "teacher_unavailable",
  "target": {
    "teacherId": "teacher_zhang"
  },
  "time": {
    "weekdays": [1],
    "periods": [1, 2, 3, 4]
  },
  "strength": "hard",
  "weight": 100,
  "confidence": 0.94,
  "status": "ready",
  "needsConfirmation": false,
  "explanation": "张老师在周一上午不可安排课程。"
}
```

约束类型至少支持：

```text
teacher_unavailable
class_unavailable
subject_preferred_time
subject_avoid_time
teacher_daily_limit
teacher_continuous_limit
class_daily_balance
subject_spacing
fixed_lesson
double_period
avoid_first_period
avoid_last_period
morning_priority
afternoon_priority
```

### 6.4 软硬约束策略

小白用户不理解硬约束和软约束，所以界面上显示：

```text
必须满足
尽量满足
可以放宽
```

后端内部映射：

```text
必须满足 -> hard
尽量满足 -> soft weight 50-80
可以放宽 -> soft weight 10-30
```

AI 需要在解析时自动判断，但必须允许用户修改。

### 6.5 约束冲突检测

新增统一冲突检测服务：

```text
timetable-constraint-conflict-service.js
```

检测类型：

1. 同一教师时间不可用与固定课冲突。
2. 课程偏好时间与教师不可用冲突。
3. 班级容量不足。
4. 教师可用时间不足。
5. 同一课程要求互斥。
6. 连堂要求与可用节次冲突。
7. 上午优先要求过多导致容量不足。

冲突结果必须返回：

```json
{
  "severity": "blocking",
  "rules": ["rule_1", "rule_2"],
  "message": "张老师周一上午不可用，但固定课要求周一第 2 节上数学。",
  "fixOptions": [
    {
      "label": "取消固定课",
      "patch": {}
    },
    {
      "label": "允许张老师周一第 2 节上课",
      "patch": {}
    }
  ]
}
```

### 6.6 约束应用闭环

当前应用规则后仍需要正式规则入口落地，体验不够完整。

重构后流程：

```text
自然语言 -> 规则草稿 -> 用户确认 -> 写入项目约束 -> 自动复查 -> 更新求解计划
```

写入前必须显示 diff：

```text
将新增：
- 张老师 周一第 1-4 节不可排课
- 体育 避开第 1 节

将修改：
- 数学上午优先 权重 60 -> 80
```

用户确认后直接保存到项目约束，不再要求用户跳到另一个入口。

## 7. 求解重构方案

### 7.1 Agent 生成求解计划

求解计划必须从约束 DSL 自动生成。

计划包括：

```json
{
  "solverPreference": "auto",
  "hardConstraints": [],
  "softConstraints": [],
  "relaxationPolicy": [],
  "fallbackPolicy": {
    "localScheduler": true,
    "timefold": true
  },
  "explain": "先保证硬约束，再优化教师和班级均衡。"
}
```

### 7.2 Timefold 与本地算法的关系

推荐策略：

1. 本地算法永远保留，用于快速预览和兜底。
2. Timefold 用于正式优化和复杂约束求解。
3. Agent 根据数据规模和约束复杂度决定优先级。

策略示例：

```text
小数据、少约束 -> 本地算法优先
大数据、复杂软约束 -> Timefold 优先
Timefold 超时或不可用 -> 本地算法兜底
本地方案有硬冲突 -> 进入诊断
```

### 7.3 自动放宽策略

当求解失败时，Agent 不应该只诊断，还要生成可执行放宽方案。

示例：

```text
方案 A：保留所有教师不可用，放宽数学上午优先。
方案 B：保留毕业班上午优先，普通班数学可排下午。
方案 C：允许体育第 1 节，但降低优先级。
```

用户点击后，系统自动修改约束权重并重新求解。

## 8. API 重构建议

建议保留现有接口，但新增一组更清晰的智能约束 API。

```text
POST /api/timetable/agent/session
POST /api/timetable/agent/message
POST /api/timetable/agent/approve

POST /api/timetable/constraints/understand
POST /api/timetable/constraints/review
POST /api/timetable/constraints/apply
POST /api/timetable/constraints/conflicts
POST /api/timetable/constraints/fix

POST /api/timetable/solve/plan
POST /api/timetable/solve/run
POST /api/timetable/solve/diagnose
POST /api/timetable/solution/save
```

所有接口统一返回：

```json
{
  "success": true,
  "data": {},
  "ui": {
    "stage": "reviewing_constraints",
    "message": "我已经理解了 6 条规则，其中 4 条可以直接应用。",
    "primaryAction": "应用可确认规则"
  },
  "warnings": [],
  "errors": []
}
```

## 9. 数据结构重构

项目中建议新增：

```json
{
  "constraints": {
    "rules": [],
    "drafts": [],
    "history": [],
    "lastReview": null
  },
  "agent": {
    "lastSessionId": null,
    "lastStage": null,
    "lastArtifacts": []
  },
  "solutions": {
    "candidates": [],
    "publishedId": null
  }
}
```

约束历史必须保存：

1. 谁创建的。
2. 来自哪句自然语言。
3. AI 置信度。
4. 用户是否确认。
5. 最后一次用于哪次求解。

## 10. 开发阶段安排

### 阶段一：止血

目标：先解决卡顿和小白入口混乱。

任务：

1. 智能约束入口改成独立工作台。
2. 拆分 Agent 面板局部渲染。
3. 禁止 Agent 操作触发课表网格全量刷新。
4. 增加数据体检第一步。
5. 约束结果按四类分区展示。

验收：

1. 输入 Agent 消息时课表网格不重绘。
2. 约束扫描时页面不卡顿。
3. 小白用户能按步骤完成一次约束解析。

### 阶段二：闭环

目标：自然语言约束可以完整落地。

任务：

1. 建立约束 DSL。
2. 统一约束解析结果。
3. 增加约束冲突检测服务。
4. 支持确认后直接写入项目约束。
5. 生成约束 diff。

验收：

1. 输入 5 条自然语言约束，至少 4 条能结构化。
2. 高置信约束可一键应用。
3. 有冲突时能给出明确原因和修复选项。

### 阶段三：Agent 主导求解

目标：AI 能生成求解计划并解释结果。

任务：

1. 正则 intent 退为兜底。
2. 增加 LLM Planner。
3. 生成求解计划预览。
4. Timefold 和本地算法统一进入候选方案对比。
5. 失败后生成可执行放宽方案。

验收：

1. 用户说“帮我开始排课”，AI 能自动检查数据、检查约束、生成求解计划。
2. 求解前必须有计划确认。
3. 求解失败后至少给出 2 个可点击调整方案。

### 阶段四：体验打磨

目标：让普通老师也能独立使用。

任务：

1. 增加示例约束模板。
2. 增加新手引导。
3. 增加候选方案对比。
4. 增加自然语言解释。
5. 增加导出前检查。

验收：

1. 没看文档的用户能完成完整排课流程。
2. 用户能理解每个失败提示。
3. 用户能知道哪些规则影响了最终课表。

## 11. 强制重构要求

### 11.1 前端

1. 不允许继续把智能约束逻辑塞进主 `controller.js`。
2. 不允许 Agent 输入框变化触发课表网格重绘。
3. 不允许用一个大弹窗承载所有智能约束流程。
4. 不允许只显示 AI 文本结果，必须显示结构化约束卡片。
5. 不允许把冲突、缺失、待确认混在同一个列表。

### 11.2 后端

1. 不允许 AI 结果直接覆盖正式课表。
2. 不允许无确认写入高风险约束。
3. 不允许只返回自然语言诊断。
4. 不允许 Timefold 失败后直接报错，必须回退本地算法。
5. 不允许约束解析结果没有置信度、来源文本和解释。

### 11.3 产品

1. 每一步只能有一个最主要按钮。
2. 每个错误都必须告诉用户下一步怎么做。
3. 每条约束都必须能解释“AI 为什么这样理解”。
4. 每次保存都必须有 diff。
5. 每次求解都必须有可读的求解计划。

## 12. 最终验收标准

重构完成后，智能约束必须满足以下验收：

1. 小白用户进入页面后知道第一步做什么。
2. 用户输入自然语言约束后，系统能结构化展示理解结果。
3. 系统能区分可应用、待确认、冲突、暂不支持约束。
4. 用户能一键应用高置信约束。
5. 应用前能看到规则 diff。
6. 约束保存后能自动复查冲突。
7. 求解前能看到求解计划。
8. 求解时 Timefold 和本地算法关系清楚。
9. 求解失败后能给出可执行调整方案。
10. 调试和普通操作过程中界面不卡顿。
11. Agent 面板、约束面板、课表网格能独立刷新。
12. 所有 AI 高风险动作都必须经过用户确认。

## 13. 推荐最终形态

最终的智能约束不应该叫“智能约束”这么技术化。

推荐页面名称：

```text
AI 排课助手
```

推荐入口文案：

```text
告诉我你的排课要求，我会帮你检查数据、整理规则、发现冲突，并生成可保存的课表。
```

推荐主流程按钮：

```text
开始检查数据
帮我理解这些要求
应用确认的规则
生成排课计划
开始生成课表
保存正式课表
```

这个重构完成后，用户感知到的不是“我在配置复杂规则”，而是：

```text
我把要求告诉 AI，AI 帮我一步步排出课表。
```

