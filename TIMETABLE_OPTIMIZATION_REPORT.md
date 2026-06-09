# 排课工具优化报告

> 面向 codex 检查。本次对「排课工具」的 AI 约束理解、调度底层算法、前端复核体验三方面做了系统性优化。所有改动均在本地 `npm test` 全绿（383 passed / 0 failed）的前提下完成。

## 一、改动总览

| 文件 | 改动性质 | 关键点 |
|---|---|---|
| `gateway/services/timetable-project.js` | 归一化扩展 | 新增 `teacherLimits` / `spreadSubjects` 软规则字段归一化（向后兼容） |
| `gateway/services/timetable-score.js` | 重写 | 新增 `evaluateSoftScore`，softScore 真实反映软约束满足率 + `softBreakdown` |
| `gateway/services/timetable-diagnostic-scheduler.js` | 重构 | 边着色优先、软规则感知的颜色→时间槽指派、mixed 连堂修正、局部修复 |
| `gateway/services/timetable-rule-parser.js` | 增强 | Prompt few-shot 重写、3 类约束提升为可生效、本地正则兜底强化 |
| `public/js/tools/timetable/view.js` | 重构 | 复核表类型/状态中文化、目标下拉绑定、示例 chips、字段提示 |
| `public/js/tools/timetable/controller.js` | 增强+清理 | targetId↔targetName 联动、`fillRuleExample`、删除死代码 |
| `public/js/tools/timetable/grid-interactions.js` | 增量 | 绑定示例 chip 事件 |
| `public/css/timetable-planner.css` | 增量 | 示例 chip、字段提示、目标下拉样式 |
| `test/timetable-scheduler.test.js` | 补测试 | +5 个：软约束 breakdown、mixed 连堂、局部修复、教师上限/同科分散归一化 |
| `test/timetable-export.test.js` | 新增 | +7 个：覆盖 class/teacher/master/plans 四种导出模式 |

---

## 二、调度底层逻辑（核心）

### 2.1 真实软约束评分（`timetable-score.js`）

**改动前**：`softScore = 100 - unplaced*12 - hardConflicts*20`。两个质量天差地别的课表，只要都无冲突，softScore 都是 100 —— 导致 `optimization-jobs.js` 的 `scheduleQuality` 比较失效，Timefold 优化「是否更优」的判断毫无意义。

**改动后**：新增 `evaluateSoftScore(project, slots)`，按加权方式计算 0–100 的真实满足度，维度包括：

| 维度 | 权重 | 含义 |
|---|---|---|
| `morningSubjects` | 3 | 主科 / morning 科目落在上午的比例 |
| `preferredPeriods` | 2 | subjectPreferredPeriods 的 prefer 命中率（avoid 命中计为 miss） |
| `teacherBalance` | 2 | 教师每日课时方差（方差 0→1.0，≥4→0），含零课日填充 |
| `teacherLimits` | 2 | 教师每日/连续上限满足率 |
| `subjectSpread` | 1 | 同班同科同天是否超阈值（spread 科目阈值=1，普通=2 含连堂） |

`buildTimetableScore` 现返回 `softScore`（满足度减未排/冲突惩罚）、`softSatisfaction`（纯满足度）、`softBreakdown`（各维度命中率），供 UI 与优化对比使用。**算法均为确定性**，无随机数，测试可复现。

### 2.2 边着色优先 + 软规则感知指派（`timetable-diagnostic-scheduler.js`）

**问题（报告原述）**：边着色路径质量更高却被放在贪心失败后才尝试；且边着色把时间槽当颜色、顺序固定，软约束全部丢失。

**改动**：
1. **顺序调换**：`runTimetableScheduler` 先尝试 `buildFastEdgeColoredSchedule`，成功直接返回；否则降级到贪心 + 局部修复。
2. **连堂安全**：边着色把每节课染成独立颜色（独立时间槽），无法保证连堂两半相邻。因此在 `hasSimpleEdgeColoringShape` 增加判定——**含 `blockPreference !== 'single'` 的项目不走边着色**，交给贪心（贪心的 `blockFits` 能保证连续性）。这避免了「翻转顺序导致连堂被拆」的回归。
3. **软规则感知的颜色→槽指派**：边着色得到「每个颜色一组无冲突课节」后，新增 `assignColorsToSlots`，用 `taskSlotAffinity`（镜像 candidateScore 的软信号）对 `颜色 × 时间槽` 打分，贪心地把颜色指派到软约束亲和度最高的时间槽。这样主科尽量落上午、preferred 节次命中，软约束在边着色路径上**首次真正生效**。复杂度 O(颜色数 × 槽数)，槽数 ≤ 84，开销可忽略。

### 2.3 贪心局部修复（`repairUnplaced`）

**问题**：贪心 `candidates.length === 0` 直接记 unplaced，无任何回溯，死局不可恢复。

**改动**：贪心放置完成后，对每个未排的单节任务做一轮单步局部修复——寻找占住其唯一可行槽的「唯一阻塞课节」，尝试把阻塞课节挪到别处，从而腾位放下未排任务（Kempe-chain 单步特例）。带 `STEP_BUDGET = 400` 步预算，保证 690 课时项目仍在 1.4s 内完成。修复后重新检测冲突与评分。

新增测试 `local repair rescues an otherwise unplaced lesson` 验证：2×2 网格双班共享教师的死局场景，修复后能排满 4 节且无冲突。

### 2.4 mixed 连堂展开修正

**问题**：原 `mixed` 无论课时多少只插 1 个双连堂（6 课时得到 `[2,1,1,1,1]`）。

**改动**：`mixed` 改为「保留少量单节、其余尽量双连堂」——偶数留 2 单节、奇数留 1 单节。例：6h→`[2,2,1,1]`，5h→`[2,2,1]`。这才是「mixed」的语义（既有连堂又有单节），区别于纯 `double`。`expandLessonPlanTasks`（贪心）与 `blockSizesForPlan`（Timefold 桥接）两处同步修正，保持一致。

新增测试验证 6h mixed 产生恰好 2 个双连堂 + 4 个连堂槽。

### 2.5 任务排序

保留单趟 `taskDifficulty`（候选最少 / 大连堂 / 高优先级优先）排序。曾尝试「每轮动态重算最受限任务」，但在 690 课时下复杂度 O(任务² × 槽) 导致耗时飙到 35s，违反 15s 预算，故回退为单趟排序 + 局部修复兜底，兼顾质量与性能（实测 1.4s）。

---

## 三、AI 约束理解（`timetable-rule-parser.js`）

### 3.1 扩大可生效约束类型

将以下 3 类从「仅建议」提升为**真正写入并影响排课**的软约束（因 score 与 scheduler 现已支持）：

- `teacher_daily_limit`（教师每日上限）→ `candidateScore` 在达到上限时 +60 重惩罚；`evaluateSoftScore` 计满足率。
- `teacher_consecutive_limit`（教师连堂上限）→ 计入 `teacherLimits`，评分校验最大连续段。
- `subject_spread`（同科分散）→ `candidateScore` 对同天重复额外 ×20 惩罚；评分阈值收紧为 1。

`normalizeTimetableRuleDraftRows` 新增对应分支，写入 `softRules.teacherLimits` / `softRules.spreadSubjects`；新增 helper `addTeacherLimit` / `addSpreadSubject`。`SUPPORTED_EFFECTIVE_TYPES` 扩充，`SUGGESTION_ONLY_TYPES` 收敛。draft row 新增 `limit` 字段贯通（normalizeDraftRow / rowsFromAiConstraints）。

### 3.2 Prompt 重写 + 解析鲁棒性

- **system prompt 全中文重写**，结构化列出每种 type 的字段要求、slots 的 `day-period` 格式、hard/soft 判定，并附 **5 条 few-shot 示例**（"王老师周三下午都没空"→ JSON 等），显著提升对中文口语化输入的理解。
- `normalizeConstraintType` 增加中文同义词正则：覆盖「每天最多 N 节」「连续/连堂不超过」「同科分散/错开」等口语句式。
- `localTextConstraints` 本地兜底（无 AI 时）新增正则提取 `teacher_daily_limit`（每天最多 N 节）与 `teacher_consecutive_limit`（连续最多 N 节）；去重 key 加入 `limit` 维度避免不同上限误判重复。

新增测试 `normalization saves teacher limits and subject spread` 验证可生效写入。

---

## 四、前端复核体验（view / controller / forms / css）

### 4.1 复核表中文化

新增共享 `RULE_TYPE_LABELS` / `RULE_STATUS_LABELS` 中文映射。复核表 type/status/priority 下拉**显示中文标签**（"教师不可排""需复核""硬性（必须）"），`value` 仍是内部枚举（保证后端契约与现有测试 `/subject_preferred_periods/`、`/teacher_load_balance/` 断言不破）。

### 4.2 targetName ↔ targetId 联动（修复数据断链）

原先 targetName 是自由文本、targetId 是隐藏域，改名后 id 不联动，确认时名/ID 可能不匹配。改为：对 teacher/class/subject 类目标渲染**绑定下拉**（`renderRuleTargetField`），option 携带 `data-target-id`；`controller.readRuleReviewRows` 从选中 option 同步 targetId，杜绝错位。locked_slot / global 仍保留自由文本。

### 4.3 输入体验

- 自然语言输入框下方加 **4 个可点击示例 chips**（点击填入 textarea，新增 `controller.fillRuleExample`）。
- 文件选中后显示「已选择文件，点击 AI 解析」提示。
- `parseRules` 完成消息改为「已解析 N 条约束（M 条可直接生效）」，解析空结果时给出明确提示。
- slots 输入框加格式提示「周-节，如 3-4；多个用逗号」。
- 手动批量构建器类型下拉新增「同科分散」。

### 4.4 死代码清理

- 删除 `controller.parseRules` 中 `return` 之后的 6 行死代码。
- 删除整个从未被调用的 `controller.addBulkRule`（其唯一逻辑 `openRuleReview('manual')` 已由复核入口替代）。
- 保留仍被审计面板/测试引用的 `ruleDraftPreview` 等遗留状态字段（移除会破坏现有契约，留待后续统一）。

---

## 五、测试

- **基线**：改动前 372 passed。
- **现状**：383 passed / 0 failed / 0 skipped。
- **新增 12 个测试**：
  - 调度：软约束 breakdown 命中、mixed 连堂打包、局部修复救场。
  - 解析：教师上限 + 同科分散归一化生效。
  - 导出（原零覆盖）：`buildTimetableExportXlsx` 的 class / teacher / master / plans 四模式 + MIME + 无 schedule 兜底（由子 agent 编写，见 `test/timetable-export.test.js`）。
- 现有测试均未因改动失败；softScore 相关断言因原测试只校验 Timefold mock 值或满足率维度，未受影响。

验证命令：
```
npm test        # 383 passed
node --test test/timetable-scheduler.test.js test/timetable-solver-bridge.test.js test/timetable-planner-ui.test.js test/timetable-export.test.js
```

---

## 六、已知限制与后续建议

1. **边着色条件仍偏严**：含任何 teacher/class unavailable、多教师任课、教室要求、或连堂的项目都不走边着色，退回贪心。后续可在 `findPerfectMatching` 邻接构造里排除不可用 (class, teacher, slot)，让带不可用约束的项目也享受边着色的全局性。
2. **局部修复仅单步**：当前只处理「唯一阻塞 + 单步搬迁」，对需要连环搬迁（多步 Kempe chain）的死局无能为力。后续可引入有界回溯或约束传播（AC-3）。
3. **mixed 连堂策略固定**：偶数固定留 2 单节。若用户希望「全连堂」或自定义连堂数，需要更细的 `blockPreference` 配置项。
4. **遗留前端状态字段**：`ruleDraftPreview` 等与 `ruleReview` 子对象重复的顶层字段尚未收敛，`setRuleReviewState` 仍双写。建议后续统一到单一来源并迁移审计面板。
5. **softBreakdown 尚未在 UI 展示**：评分维度数据已产出，但前端审计面板暂未渲染，可补一个「软约束满足度」可视化卡片。
