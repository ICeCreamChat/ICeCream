# Manim 后续修复优先级计划

## P0：修复流式事件 JSON-safe

目标：任何 `/agent/stream` 事件都不能因为 numpy 标量、Path、set 等类型导致 `json.dumps` 崩溃。

建议改动：

1. 在 `manim-service/app/agent/routes.py` 新增递归 `to_json_safe(value)`。
2. `agent_run` 的 `JSONResponse(result)` 和 `agent_stream` 的 `json.dumps(event)` 都先走 `to_json_safe`。
3. 在 `visual_judge._largest_component_box()` 中把 `touchesHardEdge` 改为 `bool(...)`。
4. `failure_events.record_failure_event()` 写入前也走同一个 sanitizer。

新增测试：

- `inspect_visual_quality()` 返回值可以 `json.dumps(..., ensure_ascii=False)`。
- 构造包含 `np.bool_ / np.int64 / np.float32 / Path / set` 的 event，stream sanitizer 输出合法 JSON。

## P1：视觉检查失败分类收口

目标：用户看到的是“预览通道异常 / 代码运行错误 / 真实画面问题”的中文分类，而不是裸英文异常或笼统失败。

建议改动：

1. `visual_judge` 输出 `failureClass` 后，前端 `message-handler` 按分类显示：
   - `preview_infrastructure`：注意，允许重试/最终复检。
   - `runtime_error`：失败，进入 repair。
   - `visual_quality`：失败，给具体 finding。
2. `workflow` 在最终渲染后强制 `final_visual` 复检，复检失败不得返回成功视频。
3. 给 `Premature close`、`unexpected keyword`、`VGroup` 非 Mobject、LaTeX 失败补独立测试。

## P1：修复意图确认消息丢失

目标：用户点击“聊一聊 / 生成动画 / 解这道题”后，必须沿用原始输入，不再出现“消息不能为空”。

建议改动：

1. `intentConfirm.show(data)` 校验并保存 `originalMessage`，缺失时从 `messageHandler` 最近一次发送记录兜底。
2. `_handleIntentConfirm` 发现缺失原始消息时，不请求 `/api/message`，而是恢复输入框并提示用户。
3. 对 `chat/manim/solver` 三种按钮都加测试。

## P1：把 sine repair 前移

目标：`画一个正弦函数，做分步骤讲解动画` 在 strict smoke 中稳定 `repairCount=0`。

建议改动：

1. 从 `logs/audit-smoke-sine.json` 对应运行中提取 repair observation。
2. 如果是布局/视觉问题，加入 `manim_knowledge` 规则或 `code_writer` 约束。
3. 如果是生成随机性，降低函数图像 prompt 的自由度，强化符号刻度、header/step/graph/summary 分区和 final wait。

## P2：开发体验和产物清理

目标：减少本地调试噪音。

建议改动：

1. dev/smoke 脚本设置 UTF-8 输出环境。
2. 添加静态视频清理脚本，仅保留最近 N 个产物。
3. 工作台默认不加载历史 jobs/failures 的行为加前端测试，防止回归。
