# Manim 子项目完整审计报告

审计时间：2026-05-16  
范围：`manim-service`、`services/manim`、`public/js/core/message-handler.js`、`public/js/core/manim-workbench.js`、`public/js/core/code-panel.js`、相关测试与 smoke 日志。  
使用方法：Superpowers systematic-debugging、security-review、ai-regression-testing。

## 基线结果

- Python 环境：`manim-service\.venv\Scripts\python.exe` 为 Python 3.12.8，Manim Community 0.20.1。
- Python 单元测试：`manim-service\.venv\Scripts\python.exe -m unittest discover manim-service/tests`，80 个测试通过。
- Node/前端测试：`npm test -- test/manim-agent.test.js test/manim-env-check.test.js test/manim-suggestions.test.js`，22 个测试通过。
- 本轮真实 smoke 单 case 重跑：6/6 通过，6/6 strict quality 通过。
- 质量隐患：`sine` case 通过但触发了 1 次 repair，质量分 96；其它 5 个 case repairCount 为 0。
- 之前 `logs/manim-agent-smoke-latest.json` 中 `tcp-flow` 失败，单独重跑后通过，判定为上游/流式传输瞬态失败，而不是固定 prompt 失败。

## P0 / P1 发现

### P0：流式事件可能因 numpy 标量无法 JSON 序列化而中断

证据：
- `logs/manim.err.log` 记录 `/agent/stream` 在 [routes.py](manim-service/app/agent/routes.py:72) 直接 `json.dumps(event, ensure_ascii=False)` 时抛出：
  `TypeError: Object of type bool is not JSON serializable`
- 本地复现：对已有视频调用 `inspect_visual_quality(...)` 后 `json.dumps(report)`，多个视频均失败。
- 进一步定位：非 JSON 安全值位于 `root.metrics.frame.layout.bbox.touchesHardEdge`，类型是 `numpy.bool_`，来源在 [visual_judge.py](manim-service/app/agent/visual_judge.py:344)。

影响：
- 前端会表现为流式中断、Abort、Premature close 或“生成超时”，即使 agent 内部已经完成部分流程。
- 这类问题会绕过业务错误处理，用户看到的是不稳定连接，而不是可操作的中文诊断。

建议修复：
- 在 `/agent/stream` 和 `/agent/run` 输出边界增加递归 `json_safe()`，统一转换 `numpy.bool_ / numpy.integer / numpy.floating / Path / set`。
- 同时把 `visual_judge._largest_component_box()` 的 `touchesHardEdge` 显式 `bool(...)`。
- 新增单元测试：`visual_judge` 报告和任意 agent event 必须 `json.dumps(..., ensure_ascii=False)` 成功。

### P1：视觉检查的通道异常、代码运行错误和真实视觉失败仍容易混在一起

证据：
- 工作流已经有 `_is_preview_infrastructure_report` 和最终视觉复检，但用户近期仍遇到 `Premature close`、`Mobject.__getattr__...unexpected keyword` 这类错误在“视觉检查”阶段暴露。
- [workflow.py](manim-service/app/agent/workflow.py:590) 之后预览渲染、视觉检查、修复路径复杂，单一 `visual_check` 事件承载了“预览通道异常”和“画面质量失败”两类不同问题。

影响：
- 用户会误以为“视觉检查不靠谱”，而实际有时是 ffmpeg/stream 通道问题，有时是代码运行错误，有时才是画面问题。

建议修复：
- 把 `failureClass` 明确透传到前端：`preview_infrastructure_warning` 用“注意”，`runtime_error` 和真实视觉 finding 用“失败”。
- 对 `unexpected keyword`、`Mobject.__getattr__`、`VGroup` 子对象错误继续前移到 critic。
- 视觉检查失败时在 process card 中显示 finding code 和中文根因，不显示原始英文堆栈。

### P1：常见正弦函数仍会依赖 repair

证据：
- `logs/audit-smoke-sine.json`：`codeSourceCounts.repair = 1`，`qualityScore = 96`。
- 同 prompt 在最新 full smoke 中曾 0 repair，但单 case 复跑出现 1 repair，说明生成仍有随机波动。

影响：
- 正弦函数是高频场景，如果经常靠 repair，生成时间和稳定性都会变差。

建议修复：
- 从该 case 的 repair observation 中提取触发原因，前移为 prompt/API 规则或静态检查。
- strict smoke 对核心 6 prompt 增加“理想门槛”：`repairCount == 0` 作为黄色告警，而非硬失败。

### P1：意图确认选择后可能丢失原始消息

证据：
- 用户复现：“等差数列前 n 项和”弹出“聊一聊 / 生成动画 / 解这道题”，选择“聊一聊”后报“消息不能为空”。
- [app.js](public/js/app.js:240) `_handleIntentConfirm` 依赖 `data.originalMessage`。
- [message-handler.js](public/js/core/message-handler.js:425) 只在 `response.needConfirmation` 分支补 `response.originalMessage = message`；如果其它路径触发 `intentConfirm.show()` 没有带上原始消息，就会提交空消息。

影响：
- 用户选择确认按钮后不是继续原请求，而是得到空消息错误，体验割裂。

建议修复：
- `intentConfirm.show(data)` 内部兜底保存最后一次用户消息，或在所有调用点强制传 `originalMessage`。
- `_handleIntentConfirm` 若缺失 `originalMessage`，不要请求后端，改为把输入框恢复成原文并显示中文提示。
- 增加前端测试：三种确认选项都必须携带原始消息。

### P1：参考图分析只是启发式约束，复杂草图仍不保证严格遵循

证据：
- `reference_analyzer.py` 能输出 `ReferenceSpec`，但本地分析主要是线稿密度、bbox、圆/方/三角启发式分数。
- `visual_judge` 有 reference alignment 代码对象检查，但没有真正的多对象空间关系验证。

影响：
- 简单圆、三角、方形参考图会有帮助；复杂草图、多个对象、箭头布局、手写公式仍可能被忽略或误解。

建议修复：
- 参考图阶段补“能力边界”提示：本地会提取线稿/主体布局，复杂语义需要文字补充。
- 对参考图 smoke 增加：手绘圆、三角、空白图、文本和参考图冲突。
- 后续可选接入 VLM，但默认仍保持本地安全分析。

## P2 发现

### P2：PowerShell / Get-Content 显示中文时会出现 mojibake，但文件本身是 UTF-8

证据：
- `Get-Content` 直接显示部分文件和 JSON 日志时出现乱码。
- Python 按 UTF-8 读取同一文件，未发现 `鐢/涓/鍦/锛/�` 等真实 mojibake 标记，日志中的 prompt 也是正确中文。

影响：
- 开发时容易误判“源码乱码”，但用户界面不一定受影响。

建议：
- dev/smoke 脚本统一设置 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`，必要时 PowerShell 设置 `[Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8`。

### P2：`manim-service/static` 下本地 mp4 产物很多

证据：
- 当前本地存在 67 个 `manim-service/static/*.mp4`，虽然 `.gitignore` 已忽略。

影响：
- 不影响提交，但会干扰人工找最新视频，也会占用磁盘。

建议：
- 加一个 `manim-service\cleanup_artifacts.py` 或 dev.bat 清理选项，仅保留最近 N 个视频。

### P2：动画工作台中 Jobs/Failures API 仍在代码中保留，产品入口需要持续防回归

证据：
- [manim-workbench.js](public/js/core/manim-workbench.js:452) `loadInitialData()` 当前只加载 skills，符合“不自动加载全局任务/失败样本”的目标。
- 但 `loadJobs()`、`loadFailures()`、`renderDebugDiagnosticsSection()` 仍保留，且 debug 模式可手动加载全局失败样本。

影响：
- 当前逻辑合理，但未来 UI 改动容易把全局失败样本重新暴露给普通用户。

建议：
- 增加测试：默认打开工作台不得请求 `/api/manim/jobs` 和 `/api/manim/failures`。
- Debug 区标题明确“开发诊断”，且只在 `localStorage.icecream_manim_debug === '1'` 展示。

## 安全边界观察

- `reference_store.py` 上传限制了 MIME、大小和安全目录，公开返回时去掉 `path`，内部解析才拿私有路径，方向正确。
- Agent 路由支持 `X-Manim-Service-Token`，但如果未配置 token，Manim service 直连接口无鉴权。若只绑定 localhost 风险可控；若暴露局域网或外网，需要强制 token。
- Failure log 会清洗路径和密钥，但目前也可能携带非 JSON 安全 metrics，建议和 P0 的 `json_safe` 共用。

## 结论

当前 Manim v6 已经不是早期“模板凑合能跑”的状态：核心 6 prompt 当前能真实通过，规则包、参考图、工作台、视觉检查、repair、smoke 都已经具备。

但离“稳定精品”还差三类收口：

1. 事件输出边界必须 JSON-safe，否则流式链路会随机中断。
2. 视觉检查要把通道异常、代码运行错误、真实画面错误分开呈现。
3. 常见 prompt 要减少对 repair 的依赖，把 repair 原因持续前移到规则和 prompt 约束。
