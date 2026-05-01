# ICeCream 座位助手大改/小改逻辑重构计划

## Summary
把“排座要求”和“ICeCream 座位助手”拆成两个稳定入口：排座要求负责整张座位表生成/重排，座位助手负责当前座位表内的微调。座位助手不再靠前端散落关键词直接拍板，而由后端返回结构化意图，前端按意图展示“直接执行 / 确认批量微调 / 确认重新排座”。

## Key Changes
- 增加统一聊天意图：`direct_edit`、`batch_tune`、`regenerate`、`explain`、`clarify`。
- `/api/tools/seating/chat` 返回新增字段：
  - `intent`: 上述五类之一。
  - `requiresConfirmation`: `batch_tune` 和 `regenerate` 为 `true`。
  - `confirmationText`: 前端确认条文案。
  - `arrangementPrompt`: 仅 `regenerate` 返回，用于调用现有 `/api/tools/seating/arrange`。
- 小改规则：
  - 明确学生 + 换座/移动/前后左右/指定排列，归为 `direct_edit`，有可执行 `operations` 时直接执行。
  - 不能识别学生或目标位置时归为 `clarify`，只追问，不执行。
- 批量微调规则：
  - “分散成绩弱同学”“同桌更均衡”“把爱讲话的分开”等不改布局但影响多人，归为 `batch_tune`。
  - 后端仍返回 `operations`，前端必须先确认再执行。
- 大改规则：
  - 改布局、过道、几人一组、考试模式、护法规则、重新排、整班重排、按身高/成绩全班重新安排，归为 `regenerate`。
  - 前端显示“会重新生成整张座位表”的确认条，确认后调用现有排座生成流程。
  - 取消现有前端 `shouldUseArrangementAssistant` 抢先判定，避免前后端规则漂移。

## UI Behavior
- `排座要求`：
  - 保留为整张座位表生成入口。
  - 取消输入聚焦/打字时自动上拉 AI 选择。
  - 改成静态示例 chips 或一个“补全要求”按钮，点击后才请求建议。
- `ICeCream 座位助手`：
  - 去掉聊天输入框的自动上拉 AI 建议。
  - 初始气泡保留快捷示例：检查座位、换座、分散成绩弱同学、重新排成考试模式。
  - 发送后按后端 `intent` 渲染：直接执行、确认执行、确认重新生成、追问补充信息。
- 确认条复用现有 `sp-chat-confirm`，但文案按意图区分：
  - `batch_tune`: “这会批量调整当前座位，但不改变布局，确认执行吗？”
  - `regenerate`: “这会重新生成座位表并可能大幅改变当前安排，确认继续吗？”

## Implementation Notes
- 主要改动集中在 `gateway/services/seating-chat.js`、`gateway/routes/tools.js`、`public/js/tools/seating-planner.js`。
- 后端先用确定性规则分类，再让 AI 生成回复/operations；确定性规则优先保证“大改不会误执行成一堆 move”。
- `regenerate` 的 `arrangementPrompt` 使用老师原始消息，并附加当前学生需求/策略仍由现有 arrange 请求携带。
- `batch_tune` 执行前保存到 `_chatPending`，确认后调用现有 `executeChatOps`。
- 保留本地 fallback 小改解析，但只用于 `direct_edit`，不用于 `regenerate`。

## Test Plan
- 更新 `seating-chat.test.js`：
  - 换座/移动识别为 `direct_edit`。
  - “成绩弱的分散开”识别为 `batch_tune` 且需要确认。
  - “改成考试模式/重新排/两人一组中间过道”识别为 `regenerate` 且 operations 为空。
  - 信息不足时返回 `clarify`。
- 更新 UI 静态测试：
  - 不再存在聊天输入自动 suggestion 绑定。
  - 排座要求建议改为按钮或静态 chips。
  - `sp-chat-confirm` 支持批量微调和重新生成两类确认文案。
- 回归测试：
  - 现有直接换座、移动、不可坐区域 fallback、AI 排座生成、排座建议接口不破坏。
  - `npm test` 全量通过。

## Assumptions
- 采用“后端结构化意图为准”的方案，前端只做展示和执行。
- 聊天里的批量优化先做确认，不做复杂预览差异图。
- 排座要求的 AI 建议从自动上拉改为主动点击触发，降低打字干扰。
