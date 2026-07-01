# 智能排课后续改进备忘录

本文记录如何参考 `reference/timetable-v2/` 改进当前智能排课。当前前端体验和入口保持旧版，不恢复 V2 工作台，不重新加载 V2 bundle。

## 先看这一段

这份计划的核心不是把 V2 界面搬回来，而是让现在这个旧版智能排课变得更聪明。

简单说：

- **界面不换**：还是现在课堂工具箱里的“智能排课”。
- **入口不换**：还是现在的 `timetable-planner`。
- **接口不换**：还是现在的 `/api/tools/timetable`。
- **只借能力**：从 V2 参考项目里借“诊断、解释、导入报告、求解策略”。
- **不借外壳**：不恢复 V2 工作台，不加载 V2 的前端 bundle，不挂 V2 接口。

## 借鉴后用户能看到什么变化

| 借鉴方向 | 现在可能的感觉 | 改进后希望变成 |
|---|---|---|
| 诊断报告 | 只知道“有冲突”或“没排完” | 明确告诉你：哪个班、哪个老师、哪门课、为什么卡住 |
| 导入报告 | 导入后不知道哪些数据被忽略 | 显示：保留了什么、降级了什么、丢了什么、哪些要人工确认 |
| 未排原因 | 排不出来时只看到失败结果 | 能看到每个未排课程的具体原因 |
| 冲突解释 | 冲突信息比较散 | 按教师、班级、课程、教室归类，方便定位 |
| 修复建议 | 需要自己猜怎么改规则 | 给出“可以尝试放宽哪个限制、检查哪个数据”的建议草稿 |
| 求解稳定性 | 同一份数据有时不好复现问题 | 加 seed 后，同样数据可以复现同样排课结果 |
| 排课成功率 | 卡住后修复能力有限 | 借鉴 V2 的换位思路，尝试挪开阻塞课程再安排 |
| 规则识别 | 不清楚自然语言规则有没有生效 | 明确显示：已应用、部分理解、不支持、需要复核 |

## 最推荐先做什么

优先级从低风险到高风险：

1. **先做诊断报告**（已完成）
   - 用户最容易感知。
   - 不需要换前端。
   - 只是在现在弹窗、智能助手或侧栏里把问题说清楚。
   - 当前已新增统一 `diagnostics` 报告：`items`、`summary`、`byObject`、`suggestions`。
   - 当前已接入旧版排课生成和手动调整刷新，旧字段继续保留。
   - 当前旧版 inspector 已能展示诊断摘要、问题项和建议草稿。

2. **再做导入报告**（已完成）
   - 解决“导入后不知道丢了什么”的问题。
   - 对学校真实数据很有用。
   - 当前任课数据预览和确认导入已追加 `importReport`。
   - 报告按 `kept`、`degraded`、`dropped`、`review` 四类归档。
   - 当前旧版导入复核弹窗已展示导入报告摘要和重点条目。
   - 当前规则解析也已追加 `ruleReport`，自然语言/约束文件解析后同样显示“保留、降级、丢弃、待审”。
   - 这样用户能一眼看到哪些规则会生效、哪些只是建议、哪些需要人工确认、哪些不能直接用。

3. **再做未排原因和可复现 seed**（已完成）
   - 排不出来时更容易定位。
   - 后续优化也更容易对比。
   - 当前旧版 scheduler 已有确定性排序，同一份数据默认可复现。
   - 当前未排课程已经带 `reason`，并会进入统一 `diagnostics`。
   - 当前已给 scheduler、API 和 agent local solve 增加显式可选 seed，并写回 `schedule.solverStats.seed`。
   - seed 只参与同分候选的稳定 tie-break，不为了 seed 引入不必要随机性。

4. **最后再动求解策略**（已完成）
   - 比如递归换位、局部优化。
   - 这部分收益高，但也更容易影响原有排课结果，所以要慢慢做。
   - 当前已创建 OpenSpec：`update-legacy-timetable-solve-strategy`。
   - 当前已补 legacy scheduler 基准样例和对比 helper。
   - 当前已实现初版：难度排序、候选压力评分、有界换位 repair、local improvement 统计和 solverStats 元数据。
   - 当前 targeted tests 和 `npm test` 已通过。

一句话总结：**先让系统把问题说明白，再让它排得更好。**

## 当前进度

这一轮计划里，已经落地的核心代码项如下：

- 诊断报告
- 导入报告
- 规则报告
- Escape 行为调整
- seed / 可复现求解
- 求解策略增强提案
- 求解策略增强代码

当前没有新的“进行中”代码项，也没有挂起的必做实现项。

为避免后续阅读时把“后端数据已具备”和“前端已完整展示”混在一起，这份文档下面默认按下面口径来写：

- “已完成” = 对应代码、接口或现有测试已经落地。
- “已展示” = 当前旧版前端界面里已经能直接看到。
- “浏览器冒烟已完成” 只有在真实页面路径被单独验证过时才会这样写；如果只是服务层测试、渲染测试或源码结构测试，这里会直接写成“现有测试已覆盖”。

如果你想看更细一点，下面这张表就是当前状态：

| 项目 | 状态 | 已经做到哪里 | 下一步 |
|---|---|---|---|
| 诊断报告 | [x] 已完成 | 已新增统一 `diagnostics`；后端已产出 `items`、`summary`、`byObject`、`suggestions`，并接入旧版排课生成、手动调整；当前 inspector 已展示摘要、问题项、对象归类和建议 | 暂无必做项；后续如果继续优化，可再补更细分组或展开交互 |
| 导入报告 | [x] 已完成 | 任课数据导入已返回并展示 `importReport`，按保留、降级、丢弃、待审分类 | 暂无必做项；后续有新导入格式时继续复用 |
| 规则报告 | [x] 已完成 | 自然语言规则解析已返回并展示 `ruleReport`，能说明规则是否生效、降级、丢弃或需要复核 | 暂无必做项 |
| Escape 行为 | [x] 已完成 | 排课工作台和课堂工具箱相关弹窗已调整为先退当前层级，不再按一下 Esc 就退出整个工具 | 暂无必做项 |
| seed / 可复现求解 | [x] 已完成 | scheduler、API 和 agent local solve 已支持可选 seed，并写回 `solverStats.seed`；缺省行为保持原样；OpenSpec 已归档 | 暂无必做项 |
| 求解策略增强提案 | [x] 已完成 | `OpenSpec/changes/update-legacy-timetable-solve-strategy/` 已完成并归档到 `OpenSpec/changes/archive/2026-06-30-update-legacy-timetable-solve-strategy/` | 暂无必做项 |
| 求解策略增强代码 | [x] 已完成 | 已实现难度排序、候选压力/阻塞评分、有界多 blocker repair、local improvement 硬冲突保护、solverStats 新统计 | targeted tests 和 `npm test` 已通过 |

## 后续可选优化

下面这些不是“当前没做完”，而是下一阶段如果你还想继续打磨，可以优先考虑的方向。

除了前面几项，我建议再补这些保护项。它们不一定炫，但会让后续优化不容易跑偏。

### 1. 先统一诊断口径，不急着改算法

当前旧版已经有很多信息：`audit`、`conflicts`、`unplaced`、`qualityIssues`、`publication reviewItems`。问题是这些信息比较分散。

建议第一步先做：

- 把这些问题统一整理成一份报告。
- 每条问题都有严重级别、对象、原因、建议。
- 前端只负责展示，不在前端重新判断冲突。

这样做的好处是：**先知道哪里坏，再决定怎么修。**

### 2. 每个问题都要能定位到对象

不要只显示“有冲突”，而是要尽量定位到：

- 哪个班级
- 哪个教师
- 哪门课程
- 哪个教室
- 哪一天哪一节
- 哪条规则或任课计划

这样用户才能真的改数据，而不是看一堆泛泛的提示。

### 3. 改进前后要能比较

后续如果动求解策略，要能回答：

- 未排课程有没有减少
- 硬冲突有没有减少
- 软规则问题有没有减少
- 排课结果是不是稳定
- 是否牺牲了原来已经能排好的样例

建议后续准备几份固定样例，用来做回归比较。

### 4. 新字段只能追加，不能破坏旧前端

后端可以增加 `diagnostics`、`migrationReport`、`suggestions` 这类字段，但旧字段要继续保留：

- `schedule.conflicts`
- `schedule.unplaced`
- `schedule.audit`
- `schedule.qualityIssues`
- `schedule.score`
- `schedule.solverStats`

这样当前旧版前端不会突然坏掉。

### 5. 建议永远是草稿

系统可以告诉用户“建议放宽教师不可用”“建议检查某班总课时”，但不要自动替用户改规则。

原则：

- 建议可以展示。
- 建议可以一键复制或后续确认应用。
- 但默认不能自动写入项目。

### 6. 发布前检查要和诊断打通

当前发布前已经会检查能不能发布。后续最好让“检查课表”和“发布前检查”共用同一套问题结构。

这样用户看到的提示不会前后矛盾：

- 检查课表说 A 问题
- 发布时也能看到同一类 A 问题
- 严重级别一致
- 修复建议一致

### 7. 真实样例比空想算法重要

后续改求解策略前，建议先收集或构造几类样例：

- 小学/初中常规样例
- 多班多教师样例
- 有连堂课样例
- 有固定课样例
- 有教师不可用样例
- 有教室限制样例
- 故意排不满的异常样例

这些样例能防止“算法看起来更高级，但真实场景更差”。

## 当前约束

- 当前课堂工具箱入口保持 `public/js/tools/app-launcher.js` 中的 `module: 'timetable-planner'`。
- 当前页面样式保持 `public/index.html` 中的旧版 CSS：`timetable-planner.css`、`timetable-smart-workbench.css`、`timetable-chat.css`、`timetable-smart-helper.css`。
- 当前前端代码继续使用 `public/js/tools/timetable/`，不从 `reference/timetable-v2/public/js/tools/timetable-v2/` import 运行时代码。
- 当前后端接口继续使用 `/api/tools/timetable`、`/api/tools/timetable/agent`、`/api/timetable/agent`。
- `reference/timetable-v2/` 只作为代码和设计参考，不挂载 `/api/tools/timetable-v2`，不加入打包脚本，不作为运行依赖。

## 可参考但不直接接回的内容

### [x] 诊断报告（已完成）

参考文件：

- `reference/timetable-v2/gateway/services/timetable-v2/diagnostics/report.js`
- `reference/timetable-v2/gateway/services/timetable-v2/diagnostics/explain.js`
- `reference/timetable-v2/gateway/services/timetable-v2/diagnostics/suggest.js`

可吸收点：

- 将未排课程、硬冲突、软约束违反、数据审计统一成 `items` 列表。
- 增加 `summary` 统计，区分 `error`、`warning`、`info`。
- 增加按教师、班级、课程、教室倒排的 `byObject`，方便当前旧版 UI 在侧栏、弹窗或智能助手中定位问题。
- 建议项只作为草稿展示，不能自动写入项目，避免用户误以为系统已经修改规则。

落地到当前代码时，优先改后端服务层，例如：

- `gateway/services/timetable-audit.js`
- `gateway/services/timetable-conflicts.js`
- `gateway/services/timetable-validation.js`
- `gateway/services/timetable-diagnostic-scheduler.js`
- `gateway/services/timetable-agent/skills/diagnosis-skill.js`

前端只消费后端返回的诊断数据，保持现在旧版入口和布局。

### [x] 导入迁移报告（已完成）

参考文件：

- `reference/timetable-v2/gateway/services/timetable-v2/importers/migration-report.js`
- `reference/timetable-v2/gateway/services/timetable-v2/importers/excel.js`
- `reference/timetable-v2/gateway/services/timetable-v2/importers/legacy-project.js`
- `reference/timetable-v2/gateway/services/timetable-v2/importers/yqd.js`
- `reference/timetable-v2/gateway/services/timetable-v2/importers/crystal-mapping.js`

可吸收点：

- 为导入过程建立统一报告，分为 `kept`、`degraded`、`dropped`、`review`。
- 记录来源位置、字段名、原因、原始值，避免静默丢数据。
- 导入完成后给当前旧版前端返回报告，由现有检查课表、智能助手或导入结果弹窗展示。

落地到当前代码时，优先改：

- `gateway/services/timetable-import.js`
- `gateway/services/timetable-rule-parser.js`
- `gateway/services/timetable-store.js`
- `test/timetable-rule-parser.test.js`
- `test/timetable-planner-ui.test.js`

### [x] 求解流程（策略增强初版已完成）

参考文件：

- `reference/timetable-v2/gateway/services/timetable-v2/solver/pipeline.js`
- `reference/timetable-v2/gateway/services/timetable-v2/solver/difficulty.js`
- `reference/timetable-v2/gateway/services/timetable-v2/solver/construct.js`
- `reference/timetable-v2/gateway/services/timetable-v2/solver/improve.js`
- `reference/timetable-v2/gateway/services/timetable-v2/solver/rng.js`

可吸收点：

- 使用 seed 控制同分候选的稳定选择，方便复现同一批排课结果。（已完成）
- 先计算活动难度，再排最难的课程。（初版已完成）
- 保留锁定课、固定课优先就位。
- 在初始解后做小预算局部优化，改善软约束得分。（已补统计和硬冲突保护）
- 排不满时返回部分解和结构化未排原因，而不是只返回失败。（已追加 repair/blocking 原因）

注意：

- 不建议一次性替换当前 `gateway/services/timetable-scheduler.js`。
- 应分小步移植，每次只引入一个策略，并用旧版测试守住现有行为。
- 当前前端接口返回结构要保持兼容；如果增加字段，应作为可选字段追加。
- 当前已完成 seed / 可复现、基准样例、难度排序、候选压力评分、有界 repair、local improvement 统计。
- 当前 targeted tests 和 `npm test` 已通过。

### [x] 约束和规则解释（已完成）

参考文件：

- `reference/timetable-v2/gateway/services/timetable-v2/constraints/registry.js`
- `reference/timetable-v2/gateway/services/timetable-v2/constraints/index-builder.js`
- `reference/timetable-v2/gateway/services/timetable-v2/constraints/nl-parser.js`
- `reference/timetable-v2/gateway/services/timetable-v2/constraints/dsl.js`

可吸收点：

- 把约束注册、约束编译、规则解释分层，减少规则解析和求解逻辑互相缠绕。
- 对不支持的自然语言规则返回 `unsupportedRules` 或 `review`，提示人工确认。
- 规则诊断尽量由后端生成，前端只负责展示。

当前已落地：

- `gateway/services/timetable-rule-parser.js` 会给规则解析、规则澄清、规则重新校验结果追加 `ruleReport`。
- `ruleReport.summary` 固定统计 `kept`、`degraded`、`dropped`、`review`。
- 旧版智能规则复核工作台会展示“规则报告”，但仍保留原来的复核卡片、分区、确认生效流程。
- 这一步只让用户看清楚解析结果，不自动替用户改规则。

落地到当前代码时，优先看：

- `gateway/services/timetable-rule-parser.js`
- `gateway/services/timetable-constraint-conversation.js`
- `gateway/services/timetable-agent/skills/constraint-skill.js`
- `public/js/tools/timetable/rule-review-tasks.js`

### UI 展示思路（已部分借鉴，后续可继续参考）

参考文件：

- `reference/timetable-v2/public/js/tools/timetable-v2/components/insight-panel.js`
- `reference/timetable-v2/public/js/tools/timetable-v2/components/conflict-group.js`
- `reference/timetable-v2/public/js/tools/timetable-v2/components/mobile-drawer.js`
- `reference/timetable-v2/public/js/tools/timetable-v2/views/result-diagnostics.js`

可吸收点：

- 只借鉴“诊断分组、摘要、草稿建议、导入反馈”的展示结构。
- 不搬回 V2 三栏工作台，不替换当前旧版排课工作台。
- 当前旧版前端应继续从 `public/js/tools/timetable/view.js`、`view-smart-helper.js`、`smart-workbench/` 内部增量调整。

## 推荐实施顺序

1. **[x] 诊断数据标准化**
   - 后端新增或整理统一诊断结构。
   - 前端先在现有检查课表弹窗、智能助手或工作台侧栏中展示新增字段。
   - 不改入口，不改主流程。
   - 当前已完成。

2. **[x] 导入报告增强**
   - 给导入和规则解析补充 kept/degraded/dropped/review 报告。
   - 前端沿用当前弹窗风格展示报告。
   - 重点避免导入后用户不知道哪些数据被忽略。
   - 当前任课导入已显示 `importReport`，规则复核已显示 `ruleReport`。
   - 当前已完成代码接入和现有测试验证。

3. **[x] 求解可复现和未排解释**
   - 给当前 scheduler 增加可选 seed。
   - 逐步增加未排原因和冲突阻塞解释。
   - 保持现有 API 字段兼容。
   - 当前已完成可选 seed、API/agent 透传和 metadata 回写；未排原因已进入统一诊断。

4. **[x] 局部求解优化**
   - 先移植难度排序，再考虑局部软约束优化。
   - 每次优化都需要对比旧版测试和真实样例。
   - 当前已创建 OpenSpec 提案，并先补了基准样例。
   - 当前已完成初版算法增强：`legacy_enhanced_v1` 保持旧 `strategy: 'greedy_constraints'` 兼容，同时新增 `strategyStats`、`repairStats`、`localImprovement`。
   - 当前 targeted tests 和 `npm test` 已通过；OpenSpec 已归档。

5. **[x] 规则能力补强**
   - 对自然语言规则增加“不支持/需复核”的明确反馈。
   - 避免前端静默吞掉规则。
   - 当前已完成规则报告能力和现有测试验证。

## 不建议做的事

- 不要把 `reference/timetable-v2/public/js/tools/timetable-v2/entry.js` 接回当前入口。
- 不要恢复 `timetable-v2` CSS 到 `public/index.html`。
- 不要从运行代码中 import `reference/` 目录。
- 不要重新挂载 `/api/tools/timetable-v2`。
- 不要一次性替换当前旧版求解器。
- 不要为了参考 V2 UI 改变当前旧版前端主体验。

## 验证清单

每一轮改进后至少检查：

- `rg "timetable-v2" public gateway package.json` 不应出现新的运行时引用。
- `public/js/tools/app-launcher.js` 仍然使用 `module: 'timetable-planner'`。
- `public/index.html` 不新增 `timetable-v2.css`。
- `/api/tools/timetable` 旧接口保持可用。
- `node --test test/timetable-planner-ui.test.js`
- `node --test test/timetable-scheduler.test.js`
- `node --test test/timetable-rule-parser.test.js`
- 涉及智能助手时补跑 `node --test test/timetable-smart-helper.test.js test/timetable-smart-workbench.test.js`。
- 涉及 agent 时补跑 `node --test test/timetable-agent-core.test.js test/timetable-agent-planner.test.js test/timetable-constraint-chat.test.js`。

## 后续决策点

前四项核心借鉴已经落地。后续如果继续优化，建议只保留这些新方向：

- 收集更多真实学校样例，作为后续算法回归样本。
- 观察 `legacy_enhanced_v1` 在真实数据上的未排数量、repair 次数和耗时。
- 如果真实样例仍有卡点，再单独开新 OpenSpec 做更强的多 seed 择优或更深 ejection chain。

## 最后补一眼：文档里哪些还没做

这一段是给后面快速看进度用的。

### 明确还没做成当前现状的

- 真实浏览器冒烟验证还不能统一算“全部完成”。
  - 当前已经补了三条真实页面冒烟：
    - 打开首页、进入课堂工具箱、打开“智能排课”、确认旧版工作台成功挂载。
    - 用示例任课数据走完“导入任课 -> 解析检查 -> 确认导入 -> 生成课表 -> 确认发布成功 -> 触发正式导出 -> 清空后恢复发布版 -> 再次发布 -> 打开发布历史 -> 导出历史版本”这条关键路径。
    - 用示例任课数据走完“打开智能约束 -> 切换文字模式 -> 解析规则 -> 预览规则变化 -> 确认规则生效”这条关键路径。
  - 但这还不等于所有排课流程都已经有独立浏览器级验证。
  - 如果后面继续补，优先级更高的会变成异常路径、失败提示和边界数据场景。

- V2 的一些 UI 展示思路只是部分借鉴，没有完整搬到旧版前端。
  - 例如更完整的诊断分组、结果面板组织方式、移动端抽屉式展示。
  - 当前策略仍然是保留旧版入口和旧版工作台，只做增量吸收。

### 不是没做完，而是后续可继续优化的

- 如果后面有新的导入格式，可以继续复用现在的 `importReport` 结构。
- “检查课表”和“发布前检查”还可以进一步统一成同一套问题结构。
- 还可以继续补固定回归样例，方便每次改算法前后做稳定对比。
- 还可以继续收集真实学校样例，观察 `legacy_enhanced_v1` 的未排数量、repair 次数和耗时。
- 如果真实样例仍然卡住，再单独开新 OpenSpec 做更强的多 seed 择优或更深的 ejection chain。

### 这一轮刚补上的

- 诊断报告的“对象归类”前端展示已补到当前旧版 inspector。
- “发布前检查”面板现在会把发布问题按严重级别结构化展示，不再只是散的提示文本。
- “排课诊断”面板也开始按结构化问题列表展示，和“发布前检查”的问题表达更统一了。
- 已新增最小真实浏览器冒烟脚本：`test/timetable-ui-smoke.mjs`。
- 已新增更深一层的关键路径浏览器冒烟：`test/timetable-ui-workflow-smoke.mjs`。
- 已新增规则复核浏览器冒烟：`test/timetable-ui-rule-review-smoke.mjs`。
- `package.json` 已新增：`npm run test:timetable:ui-smoke`。
- `package.json` 已新增：`npm run test:timetable:workflow-smoke`。
- `package.json` 已新增：`npm run test:timetable:rule-review-smoke`。

### 一句话结论

当前这份文档里，核心代码项基本都已经落地。

真正还没做的，主要是：

- 更完整的真实浏览器级流程覆盖
- 下一阶段的算法和样例继续打磨

## 最下面再放一版超直白结论

如果你只是想快速知道“还有什么没做”，直接看这里就够了。

### 1. 已经做完的

- 旧版 timetable 已经保住，而且还是当前运行中的智能排课前端入口。
- 诊断统一结构、导入报告、规则报告、seed 透传、未排原因、第一轮求解增强，这些都已经落地到代码里了。
- 诊断里的“对象归类展示”前端也已经补上。
- 最小真实浏览器冒烟也已经补上，能验证“从首页点进智能排课，旧版工作台成功打开”。
- 关键路径浏览器冒烟也已经补到“导入任课 -> 生成课表 -> 确认发布成功 -> 触发正式导出 -> 清空后恢复发布版 -> 再次发布 -> 打开发布历史 -> 导出历史版本”这一层。
- 规则复核浏览器冒烟也已经补上，能验证“打开智能约束 -> 解析规则 -> 预览变化 -> 确认生效”。

### 2. 现在明确还没做的

- 还没有把“智能排课整条流程”做成完整的浏览器自动化覆盖。
- 还没有把“检查课表”和“发布前检查”彻底收敛成同一套前后端问题展示结构。
- 还没有继续做第二阶段、更激进的算法增强。

### 3. 这些不是没做，只是还能继续变强

- 可以继续补更多真实学校样例，作为后面调算法的回归样本。
- 可以继续观察 `legacy_enhanced_v1` 在真实数据上的未排数、repair 次数、耗时。
- 可以继续补更完整的浏览器级流程测试，比如异常提示、失败回退、边界数据场景。
- 如果后面真实数据仍然排不出来，再单独开新 OpenSpec 做多 seed 择优或更深的 repair/ejection chain。

### 4. 一句话判断

这份文档里写到的“核心改造项”，现在基本都已经做进代码了。

当前剩下的，主要不是“旧功能没恢复”，而是“后续还能继续打磨得更强”。

## 最终版：当前还没做的，直接看这里

这是放在最下面的一版，专门给以后快速看进度用。

### 代码层面明确还没做完的

- 还没有把“智能排课”完整做成全链路浏览器自动化。
  - 现在已经覆盖到：首页进入排课、导入示例任课、解析检查、确认导入、生成课表、确认发布成功、触发正式导出、清空后恢复发布版、再次发布、打开发布历史、导出历史版本，以及规则复核解析到确认生效。
  - 但还没完整覆盖：异常提示、失败回退、边界数据场景等更细的浏览器链路。

- “检查课表”和“发布前检查”还没有彻底收敛成同一套结构。
  - 现在两边都已经比以前更结构化了。
  - 但还没有完全做到前后端字段、分组方式、展示组件彻底统一。

- 第二阶段更强的求解增强还没开始做。
  - 现在已落地的是 `legacy_enhanced_v1`。
  - 还没继续做多 seed 择优、更深 repair / ejection chain 这一层。

### 这些不算没做完，而是后续还能继续加强

- 继续补真实学校样例，做算法回归样本库。
- 继续观察 `legacy_enhanced_v1` 在真实数据里的未排数、repair 次数、耗时。
- 继续补更完整的真实页面冒烟和自动化回归。

### 最短一句话

旧版智能排课已经恢复并且核心增强基本落地；现在真正没做完的，主要只剩“更完整自动化验证”和“下一阶段更强算法优化”。

## 进度速览（四块版）

这一段专门放在最下面，后面如果你只想快速看“现在到底做到哪”，直接看这里。

### 已落地

- 旧版智能排课已经恢复为当前正式运行入口，前端没有切回 `timetable-v2`。
- 诊断统一结构已经落地，后端已产出 `diagnostics`、`summary`、`byObject`、`suggestions`。
- 导入报告已经落地，任课导入会返回并展示 `importReport`。
- 规则报告已经落地，规则解析和复核会返回并展示 `ruleReport`。
- seed / 可复现求解已经落地，scheduler、API、agent local solve 都能带 seed，并写回 `solverStats.seed`。
- 第一阶段求解增强已经落地，也就是现在的 `legacy_enhanced_v1`。
- Escape 交互已经调整，按 `Esc` 会优先退出当前层，不会直接把整个排课工作台关掉。

### 当前可见

- 在旧版排课工作台里，已经能直接看到诊断摘要、问题项、对象归类和建议草稿。
- 在导入复核里，已经能看到“保留 / 降级 / 丢弃 / 待审”这类导入报告。
- 在规则复核里，已经能看到哪些规则已生效、哪些只是建议、哪些需要人工确认。
- 在发布前检查里，已经能看到结构化的发布问题，而不只是零散提示。
- 在真实页面冒烟里，已经验证过：
  - 首页进入智能排课并成功打开旧版工作台。
  - 示例任课从导入到生成、发布、恢复、历史导出这条关键路径。
  - 智能约束从解析到预览再到确认生效这条关键路径。

### 后续可选优化

- 继续补更多真实学校样例，做稳定的算法回归样本库。
- 继续观察 `legacy_enhanced_v1` 在真实数据里的未排数、repair 次数和耗时。
- 继续补更完整的浏览器自动化，尤其是异常提示、失败回退、边界数据场景。
- 如果真实样例里仍然有明显卡点，再单独开新 OpenSpec 做多 seed 择优或更深 repair / ejection chain。

### 明确未做

- 还没有把“智能排课整条业务链路”做成完全覆盖的浏览器自动化。
- 还没有把“检查课表”和“发布前检查”彻底统一成同一套前后端问题结构和展示组件。
- 还没有开始第二阶段、更激进的算法增强，比如多 seed 择优、更深层的 repair / ejection chain。

### 一眼结论

现在不是“旧版没恢复”或者“核心能力没落地”的状态了。

现在更准确的说法是：**旧版已经恢复，第一轮增强也已经做进代码；剩下的是继续打磨测试覆盖和下一阶段算法优化。**

## 补充：代码里现在明确还没做完的点

这一段专门放最下面，后面只想看“还差什么”时，直接看这里。

- 还没有把智能排课做成完整的全链路浏览器自动化回归。
  - 现在已经覆盖了主路径。
  - 但异常提示、失败回退、边界数据场景还没有全补齐。

- “检查课表”和“发布前检查”还没有彻底合成同一套问题结构。
  - 现在两边都已经更结构化了。
  - 但前后端字段、分组方式、展示组件还没有完全收口成一套。

- 第二阶段更强的求解增强还没开始。
  - 现在落地的是 `legacy_enhanced_v1`。
  - 多 seed 择优、更深 repair / ejection chain 还没继续做。

- 真实学校样例的回归样本库还可以继续补。
  - 这不是“功能没恢复”。
  - 这是后面继续优化算法时最值钱的保护网。

最短一句话：**核心功能已经恢复并增强，当前真正还没做完的，主要是更完整自动化验证，以及下一阶段算法继续打磨。**
