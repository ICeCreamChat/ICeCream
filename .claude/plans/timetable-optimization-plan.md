# 排课工具全面优化方案（AI 约束理解 + 调度底层逻辑 + 前后端）

## 背景与目标

用户反馈两个核心痛点：
1. **AI 约束理解写得不好** —— 智能解析中文自然语言约束不准、复核表 UI 难用（英文枚举裸露、slots 手填、targetId/Name 断链）、可生效约束类型太少（很多有用约束只是"仅建议"不真正执行）。
2. **排课底层逻辑** —— 贪心无回溯易死局、softScore 不反映软约束满足率、边着色先后顺序反了、mixed 连堂展开不完整、静态任务排序。

验收：现有 54 个测试保持全绿（必要时同步更新被改契约的测试），并为新逻辑补测试；`npm test` 全通过。最后写一份报告到本地供 codex 检查。

执行方式：我（主 agent）主导按依赖顺序亲手改核心代码，把独立的探索/测试编写等并行任务派给子 agent。

---

## 一、调度底层逻辑重构（后端，优先级最高）

### 1.1 真实软约束评分 `timetable-score.js`
**问题**：当前 `softScore = 100 - unplaced*12 - hardConflicts*20`，完全不看软约束满足率。两个质量天差地别的课表只要都无冲突就同为 100，导致 Timefold 优化对比 (`optimization-jobs.js` 的 `scheduleQuality`) 失效。

**改动**：新增 `evaluateSoftScore(project, slots)` 计算真实软约束满足度，纳入：
- 上午科目命中率（morningSubjects / 语数英在上午的比例）
- subjectPreferredPeriods 的 prefer 命中 / avoid 命中惩罚
- 教师每日负载方差（balancedTeacherLoad）
- 同班同科同天重复扣分
- 素质课后半天倾向
返回 0–100 的真实分。`buildTimetableScore` 改为 `softScore = round(satisfaction)`，硬冲突/未排课时单独体现在 `hardConflicts`/`unplacedLessons`，并新增 `softBreakdown` 字段（各项命中率）供 UI/报告展示。保持 `buildTimetableScore` 签名兼容（仍接收 project, slots, unplaced, conflicts）。

### 1.2 边着色优先 + 软规则重排 `timetable-diagnostic-scheduler.js`
**改动**：
- **调换主次顺序**：`runTimetableScheduler` 先尝试 `buildFastEdgeColoredSchedule`（当 `hasSimpleEdgeColoringShape` 为真且成功），失败再降级到贪心。边着色能给出全局可行的完美匹配，比贪心更不易死局。
- **边着色后做软规则重排**：当前边着色把时间槽当颜色、顺序固定，软约束全丢。新增一步：在边着色得到"每个颜色一组课"后，用匈牙利/贪心把"颜色 → 实际时间槽"做一次最优指派，使高优先级科目尽量落在它偏好的槽（按 `candidateScore` 思路对 颜色×时间槽 打分后做指派），让 morning/preferred 软约束生效。
- **mixed 连堂展开修正** (`expandLessonPlanTasks` L125-130)：`mixed` 改为"尽量多双连堂直到剩 1"——`while (remaining >= 2 && remaining !== 1) addTask(2)`，即偶数全双连堂、奇数留 1 个单节。同步修 `timetable-solver-bridge.js` 的 `blockSizesForPlan` 保持一致。
- **动态任务难度**：贪心循环里每放置若干任务后对剩余任务重排序（或每次取剩余任务中候选最少的那个，改成"最受限优先"动态选择），降低难任务抢不到位的概率。

### 1.3 贪心局部搜索修复 `timetable-diagnostic-scheduler.js`（新增模块函数）
**问题**：贪心 `candidates.length===0` 直接记 unplaced，无回溯。
**改动**：贪心放置完成后，对 `unplaced` 的任务做一轮**局部修复**：
- 对每个未排任务，尝试 Kempe-chain 风格的 swap：找一个已放置的、占住该任务唯一可行槽的课节，看能否把它挪到另一个可行槽，从而腾位。
- 设迭代上限（如 200 步或 50ms 时间预算）保证性能（690 课时仍需 < 15s）。
- 修复后重新检测冲突与评分。

整体仍是确定性的（不引入 `Math.random`），保证测试可复现。

### 1.4 边着色条件放宽（可选，视时间）
`hasSimpleEdgeColoringShape` 过严（任何不可用约束就放弃）。改为：有 teacher/class unavailable 时，在 `findPerfectMatching` 的邻接构造里把不可用 (class,teacher,slot) 组合排除，仍可走边着色。若实现风险高则保留为报告中的"后续建议"，本次先不强行做。

---

## 二、AI 约束理解重写（后端 `timetable-rule-parser.js`，四个方向全做）

### 2.1 扩大可生效约束类型
把以下从"仅建议"提升为真正写入规则、影响调度的**软约束**（需 score/scheduler 支持）：
- `teacher_daily_limit`（教师每日上限）→ 评分惩罚超限
- `teacher_consecutive_limit`（连续节次上限）→ 评分惩罚
- `subject_spread` / `same_subject_spread`（同科分散）→ 已有同天重复扣分，强化为可配置规则
- `quality_subject_later`（素质课后置）→ 已隐含，显式化

在 `timetable-project.js` 的 `normalizeRules` 增加这些软规则字段的归一化；在 `timetable-score.js` 的 `evaluateSoftScore` 与 scheduler 的 `candidateScore` 中消费它们。`SUPPORTED_EFFECTIVE_TYPES` 相应扩充。保持向后兼容（旧 project 无这些字段时默认空/关闭）。

### 2.2 重写 Prompt + 解析鲁棒性 (`buildPrompt`, `callAi`, local fallback)
- 重写 system prompt：用结构化中文说明 + **few-shot 示例**（给 2-3 个"中文输入 → 期望 JSON"样例），明确每种 type 的字段要求、slots 的 `day-period` 格式、hard/soft 判定规则、置信度含义。
- 强化 `normalizeConstraintType` 的中文同义词映射表（覆盖更多口语表达："不排""空出来""挪到""集中在"等）。
- 强化 `localTextConstraints` 本地正则兜底：覆盖更多句式（"X老师周三全天没空""体育不要连着上""数学每天最多2节"），让无 AI 时也能提取更多明确规则。
- AI 返回异常时（非 JSON、空 constraints）的降级路径更稳，warnings 更可读。

### 2.3 复核表 UI 中文化与易用（前端 `view.js` + `controller.js` + `forms.js`）
见第三节前端部分（与后端 type 中文标签统一）。

### 2.4 输入体验（前端，见第三节）

---

## 三、前端优化（`public/js/tools/timetable/*` + css）

### 3.1 复核表中文化 `view.js` `renderRuleReviewRow` (L751-798)
- 新增共享的 `RULE_TYPE_LABELS` / `STATUS_LABELS` 中文映射（type 下拉、status 下拉显示中文："教师不可排""需复核""仅建议"等）。
- type/status `<option>` 显示中文标签，value 仍是内部枚举。
- **slots 可视化**：把自由文本 `1-3, 2-5` 输入改为"点开选节次"的轻量 picker（或至少加格式实时校验 + 占位提示 + 错误高亮），降低普通用户出错率。
- **targetName↔targetId 联动**：targetName 改为基于项目实体的 `<select>`（或带 datalist 的输入），选中即同步 hidden 的 targetId/targetType，杜绝名/ID 不匹配。

### 3.2 输入体验 `view.js` `renderRuleReviewInput` / `controller.js`
- 自然语言输入框下方加**实时示例提示**（可点击填入的示例 chips）。
- 文件上传后显示**解析中/解析完成/失败**的明确状态与文件类型识别结果（roster vs constraints）。
- 解析中 loading 态、失败原因中文化（已有 `normalizeApiError`，补全 reason 文案）。

### 3.3 清理死代码（前端）
- `controller.js` `parseRules()` L849-856 死代码、`addBulkRule()` L916-938 整函数死代码 → 删除。
- `view.js` `renderRulePreview()` L554-584 未被调用的旧组件 → 删除或接回（统一审计面板用同一组件）。
- `state.js` 顶层 7 个与 `ruleReview` 子对象重复的旧字段 → 收敛到单一来源，`setRuleReviewState` 不再双写。
- 入口标题统一（侧栏"AI 约束" vs dialog"约束复核中心"语义对齐）。

### 3.4 CSS 配套
为新增的 slots picker / select、状态中文标签、示例 chips 加样式，沿用现有 `--tt-*` 设计变量，保持深浅色主题一致。

---

## 四、测试与验收

### 4.1 保持现有 54 测试全绿
重构中若改动被测契约（如 softScore 数值、scheduler source 顺序、UI 字符串匹配），**同步更新对应测试断言**以反映新设计，而非删测试。重点关注：
- `timetable-scheduler.test.js`：softScore 相关、`source: 'fast_constructed'`、690 课时性能、unplaced 可解释性。
- `timetable-planner-ui.test.js`：大量 `assert.match(source, ...)` 字符串断言会因 UI 改写而需要更新。
- `timetable-solver-bridge.test.js`：`blockSizesForPlan` mixed 改动影响 `buildTimetableProblem`。

### 4.2 补新测试
- 软约束评分：构造已知课表，断言 `evaluateSoftScore` / `softBreakdown` 命中率正确。
- 边着色优先 + 软规则重排：morning 科目落在上午的比例提升。
- 局部修复：构造贪心会死局、修复后能排满的用例。
- mixed 连堂展开：6 课时 mixed → `[2,2,1,1]`。
- 新增约束类型解析与生效（teacher_daily_limit 等）。
- 导出（补缺口）：`buildTimetableExportXlsx` 四种 type 的 sheet 内容校验（对标 seating-export）。
- AI prompt：mock fetch 验证新 prompt 含 few-shot、新 type 正确映射。

### 4.3 执行
每改完一个模块即跑相关测试；全部完成跑 `npm test` 确认全绿。子 agent 用于：并行编写导出测试、并行核对 UI 测试断言更新点。

---

## 五、报告产出

完成后在仓库根目录写 `TIMETABLE_OPTIMIZATION_REPORT.md`（中文），内容：
- 改动清单（按文件，含 before/after 关键点）
- 算法层面：评分模型、边着色优先、局部修复的原理与复杂度
- AI 约束：新 prompt 策略、新增约束类型、解析鲁棒性提升点
- 前端：UI 中文化、易用性、死代码清理
- 测试：新增/更新的测试与覆盖率变化
- 已知限制与后续建议（如边着色条件放宽、引入完整 CP 回溯）
供 codex 检查。

---

## 实施顺序（依赖驱动）

1. `timetable-project.js`（归一化新软规则字段）
2. `timetable-score.js`（真实软约束评分 + breakdown）
3. `timetable-diagnostic-scheduler.js`（边着色优先、软规则重排、mixed 修正、动态排序、局部修复）+ `timetable-solver-bridge.js`（blockSizesForPlan 同步）
4. `timetable-rule-parser.js`（prompt 重写、新类型、本地兜底）
5. 前端 `view.js` / `controller.js` / `forms.js` / `state.js` / `css`（中文化、易用、死代码清理）
6. 更新现有测试 + 补新测试（含导出），`npm test` 全绿
7. 写报告 `TIMETABLE_OPTIMIZATION_REPORT.md`

每一步改完即验证，避免回归累积。
