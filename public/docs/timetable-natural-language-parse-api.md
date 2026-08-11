# 智能排课自然语言解析 API 与字段契约

> 适用范围：智能约束助手文本、TXT/CSV、XLSX、手动输入、agent 对话复核及澄清流程。
>
> 当前协议：`schemaVersion = 2`。本文件记录的是调用方必须遵守的数量、身份、来源和兼容边界，不是 UI 文案说明。

## 1. 核心数量合同

```text
一条真实用户输入
= 一个顶层 SourceRequirement
= 一张前端一级审核卡片
```

下列数组是派生层，允许相对源输入 `0:N` 或 `1:N`，不得用于计算“用户输入条数”或 agent 的“已理解条数”：

- `sourceRequirements[].clauses`
- `constraintIRs`
- `draftRows`
- `requirementItems`
- `semanticActions`

用户输入数量的真相源是：

```js
result.statistics.userInputCount
```

如果调用方需要兼容没有 `statistics` 的响应，`userInputCount` 只能回退为 `sourceRequirements` 中明确满足 `origin=user_input` 的数量。`origin=manual` 必须单独计入 `manualInputCount`；缺失或无法验证的来源必须归为 `unknown`，不能计入 `userInputCount`，也不能显示“来自你的输入”。

只要响应中存在 `sourceRequirements` 字段，即使其值是显式空数组 `[]`，该 source 层也具有权威性，调用方不得回退到 `requirementItems`、`draftRows` 或 `semanticActions` 重建用户输入。只有响应完全缺少 `sourceRequirements` 字段时，才允许进入旧协议 fallback，且不得把兼容数量宣传为 schema v2 的源输入数量。

真实 137 条基线当前为：

```text
sourceRequirements = 137
unique sourceId = 137
statistics.userInputCount = 137
clauses = 150
constraintIRs = 150
draftRows = 127
machineRuleIds = 4
requirementItems = 150
semanticActions = 2
```

只有前三个 137 是不可膨胀合同；其他数量会随能力和编译结果变化。`draftRows` 同时承载兼容机器行和审核预览行，只有携带 `machineRuleId` 的行属于机器规则。当前空项目实体上下文下 `statistics.machineRuleCount = 4`、`statistics.draftRowCount = 127`；`needs_review/unsupported` 预览行必须保留，但不得拥有 machineRuleId。

正式审计命令：

```powershell
npm run audit:timetable:natural-language-137
```

审计产物为根目录 `.tmp-audit-137.json`；当前结果为 `1970 passed checks / 0 failed checks`。

## 2. HTTP 入口

### 2.1 解析

以下两个路由当前共用同一实现：

```text
POST /api/tools/timetable/rules/parse
POST /api/tools/timetable/rule-review/parse
```

请求支持：

- JSON/表单字段 `text`；
- multipart 文件字段 `file`；
- 文件上限 5 MB；
- 支持的具体扩展名以 `parseTimetableRules()` 当前实现为准。

解析读取当前排课项目作为实体和时段上下文，但不会直接保存规则。

### 2.2 需求澄清

```text
POST /api/tools/timetable/requirements/clarify
```

请求主体：

```json
{
  "previousResult": {},
  "answers": [],
  "inputType": "requirement_clarification",
  "contextStats": null,
  "project": null
}
```

`previousResult` 可以是：

1. schema v2 新响应：包含 `sourceRequirements`，可以没有 `requirementItems`；
2. 新旧字段同时存在的过渡响应；
3. 仅包含旧 `requirementItems` 的兼容响应。

澄清实现必须优先保留 source model，并通过 sourceId/clauseId/legacy requirementId 的明确映射更新，禁止按数组下标关联答案。

### 2.3 旧规则澄清

```text
POST /api/tools/timetable/rules/clarify
```

该路由仍服务旧 `draftRows` 对话流程。新需求卡澄清优先使用 `/requirements/clarify`。

## 3. schema v2 顶层响应

典型结构：

```json
{
  "schemaVersion": 2,
  "parserVersion": "timetable_rule_parser_constraint_ir_v6",
  "parseSource": "local",
  "cacheHit": false,
  "sourceRequirements": [],
  "systemSupplements": [],
  "manualRequirements": [],
  "constraintIRs": [],
  "warningItems": [],
  "statistics": {},
  "draftRows": [],
  "requirementItems": [],
  "semanticActions": [],
  "clarifyingQuestions": [],
  "missingInfo": [],
  "conflicts": [],
  "warnings": [],
  "unsupportedItems": [],
  "nextAction": "review"
}
```

### 3.1 新协议真相源

| 字段 | 含义 | 数量规则 |
|---|---|---|
| `sourceRequirements` | 真实源需求归档 | `origin=user_input` 与用户输入严格 1:1；也可承载 manual/unknown 源 |
| `systemSupplements` | 系统/AI 主动补充但原文没有的规则 | 不计入用户输入 |
| `constraintIRs` | 经过能力路由和校验的原子语义 | 每个 source 可 0:N |
| `statistics` | 各层显式统计 | UI/agent 计数优先使用 |
| `warningItems` | 带 provenance 的结构化警告 | 不得提升为新 source |

### 3.2 兼容投影

| 字段 | 用途 | 兼容边界 |
|---|---|---|
| `requirementItems` | 旧需求审核/澄清调用方兼容 | 不再作为顶层用户输入真相源 |
| `draftRows` | 旧规则编辑和求解器写入兼容 | 一个 source 可生成 0:N 行 |
| `semanticActions` | 课时计划或复杂模型修改动作 | 必须携带稳定 source provenance |
| `autoAcceptable` / `needReview` | 旧复核流程派生列表 | 只用于状态/筛选，不用于源计数 |

兼容字段当前没有立即删除日期。删除前必须完成独立 OpenSpec 变更、调用方迁移和版本升级；不得在本重构中静默移除。

## 4. SourceRequirement 字段

典型结构：

```json
{
  "sourceId": "src:2:xlsx:自然语言约束:r2:<digest>",
  "rawText": "刘书涵老师周一第2节不要安排课。",
  "origin": "user_input",
  "parsedBy": ["local", "ai"],
  "understandingStatus": "parsed",
  "executionStatus": "compiled",
  "reviewStatus": "actionable",
  "clauses": [],
  "machineRuleIds": [],
  "warnings": [],
  "source": {
    "textHash": "<sha256>",
    "sheetName": "自然语言约束",
    "rowNumber": 2,
    "lineNumber": null,
    "rawText": "刘书涵老师周一第2节不要安排课。"
  }
}
```

### 4.1 `origin` 与 `parsedBy` 正交

`origin` 表示需求从哪里来：

```text
user_input
manual
system_supplement
unknown
```

`parsedBy` 表示谁参与了解析：

```text
local
ai
manual
review
```

AI 参与解析用户输入时：

```text
origin = user_input
parsedBy = [local, ai]
```

不得因为 `parsedBy` 包含 `ai` 就把来源改成 `system_supplement`。

来源统计规则固定为：

- 只有明确的 `origin=user_input` 计入 `statistics.userInputCount`；
- `origin=manual` 单独计入 `statistics.manualInputCount`，不能偷算进用户输入；
- `origin=system_supplement` 单独分组并计入 `statistics.systemSupplementCount`；
- 缺失、非法或无法验证的来源统一归为 `unknown`，保留卡片但不计入 `userInputCount`，UI 不得显示“来自你的输入”。

### 4.2 原文和规范化文本

- `rawText`/展示证据保留用户标点和可读文本；
- NFKC、空白折叠等规范化只用于身份哈希和匹配；
- 不得为了生成哈希改写用户看到的原文；
- source-first 一级审核卡必须优先显示 `SourceRequirement.rawText` 或 `SourceRequirement.source.rawText` 的完整原文，不能被 clause、machine rule 或兼容 `requirementItems` 中的缩短片段覆盖。

## 5. 稳定身份算法

实现文件：

```text
gateway/services/timetable-constraints/source-identity.js
```

当前常量：

```text
SOURCE_SCHEMA_NAMESPACE = timetable-natural-language-source:v2
SOURCE_SCHEMA_VERSION = 2
```

### 5.1 `textHash`

```text
SHA-256(
  namespace + "\ntext\n" + normalizeSourceText(rawText)
)
```

用于 AI 回传原文一致性校验。AI 返回已知 sourceId 但 textHash 不一致时必须拒绝关联。

### 5.2 `sourceId`

身份材料包括：

- namespace；
- kind/inputType；
- sheetName；
- row/line/item 位置；
- 规范化原文。

摘要使用稳定 JSON 后的 SHA-256 前 20 个十六进制字符。当前格式：

```text
src:2:<inputType>:<scope>:<digest>
```

XLSX scope 包含 sheet 和真实 sourceRow；自由文本 scope 包含稳定分段位置。因此：

- 相同原文、不同 sourceRow/line 必须得到不同 sourceId；
- 同一输入在相同身份材料下重复解析应得到相同 sourceId；
- 不允许按 rawText 全局去重不同来源位置。

### 5.3 `clauseId`

```text
<sourceId>:clause:<semantic-digest>
```

semantic digest 由 intent/capability、target/object/scope、condition/time、relation、parameters、strength、applyTo 等语义字段计算，不使用数组位置作为最终身份。

### 5.4 `machineRuleId`

```text
<sourceId>:rule:<rule-digest>
```

rule digest 包含 sourceId、clauseId 和去除展示/状态/provenance 元数据后的机器规则业务字段。一个 source 下不同学科或不同规则不得发生 ID 碰撞。

## 6. 状态模型

理解状态、执行状态和审核状态必须分层：

```text
understandingStatus：是否理解用户语义
executionStatus：当前 compiler/solver 是否能执行
reviewStatus/status：是否需补充、复核或可应用
```

关键语义：

```text
unsupported_by_solver = 已理解，但当前求解器暂不支持
unsupported_by_solver != 未理解
```

当 source 已理解但不能执行时：

- source 仍保留；
- clause/IR 仍保留；
- warning 仍保留；
- 允许 `machineRuleIds = []`、`draftRows = 0`；
- UI 不能隐藏卡片或伪造机器规则。

## 7. `statistics` 字段

当前主要字段：

| 字段 | 含义 |
|---|---|
| `sourceRequirementCount` | 所有顶层 source 数量 |
| `userInputCount` | `origin=user_input` 的源需求数量 |
| `manualInputCount` | 手动规则构造的源需求数量 |
| `systemSupplementCount` | 系统补充数量 |
| `clauseCount` | 原子 clause 数量 |
| `constraintIRCount` | ConstraintIR 数量（若响应提供） |
| `machineRuleCount` | 机器规则总数 |
| `executableMachineRuleCount` | 当前可执行机器规则数量 |
| `draftRowCount` | 兼容 draftRows 数量 |
| `semanticActionCount` | 语义动作数量 |
| `needsReviewCount` | 需人工复核的 source 数量 |

前端总览应分别显示这些层次，禁止用一个“已理解 196”混合表示。

## 8. AI 对齐契约

当前版本：

```text
AI extraction prompt = timetable_ai_requirement_extract_v5
AI review prompt = timetable_ai_review_v2
```

AI 结果必须回传已知 `sourceId` 和对应 `textHash`。本地处理顺序：

```text
schema 校验
-> sourceId 查找
-> textHash 校验
-> 来源证据校验
-> 实体/时间解析
-> capability route/compiler
-> 同 source 内 patch/upsert
```

以下情况拒绝关联并生成 warning/clarification，不得猜测：

- 未知 sourceId；
- textHash 不匹配；
- 重复原文导致仅靠 textHash 无法唯一定位；
- 来源位置与 sourceId 冲突；
- AI 输出缺少足够证据；
- AI 结果只能通过输出数组下标与输入对应。

AI review 只能作为本地结果的 patch/upsert，不能重建完整数组后 append。重复应用同一 review 后，各层 ID 集合必须幂等。

## 9. Parser 与缓存版本

当前 parser：

```text
PARSER_VERSION = timetable_rule_parser_constraint_ir_v6
```

文件解析缓存：

```text
最大 40 项，进程内 LRU 风格 Map
```

缓存 key 包含：

1. `PARSER_VERSION`；
2. AI review/extraction 是否启用及 prompt 版本；
3. 文件内容哈希；
4. 当前排课项目实体、活动时段、课时计划和规则的指纹。

因此 parser、AI prompt 或项目上下文改变时不应命中旧缓存。返回值包含：

```text
parserVersion
parseSource
cacheHit
```

AI extractor 自身另有进程内缓存，当前最大 200 项；其开关和配置以 `timetable-ai-extractor.js` 为准。

## 10. 调用方迁移规则

### 新调用方必须

1. 以 `sourceRequirements` 渲染一级需求；字段存在时即为权威 source 层，显式 `[]` 不得回退派生字段。
2. 以 `statistics.userInputCount` 显示用户输入数；无统计时只统计明确的 `origin=user_input`。
3. 通过 sourceId/clauseId/machineRuleId 定位编辑、删除、澄清、暂停/恢复和应用。
4. 将 `systemSupplements` 独立展示；manual 和 unknown 不得伪装成用户输入。
5. 将 clauses/rules/actions 放在 source 卡内部展开。
6. 保留 unsupported source，不伪造机器规则。
7. 一级卡显示完整 SourceRequirement 原文，机器规则片段只能作为卡内派生详情。

### 旧调用方兼容

1. 只有响应完全缺少 `sourceRequirements` 字段时，才可以继续读取 `requirementItems`/`draftRows`；显式 `sourceRequirements: []` 不属于旧协议。
2. 没有 `statistics` 时可使用旧文案，但不能覆盖新响应的显式统计，也不能把 manual/unknown 计入用户输入。
3. 旧 requirementId 与新 sourceId 必须分别保存，不能互相冒充。
4. 一旦响应包含 schema v2 新字段，调用方不得再次扁平化为“一个 requirementItem 一张用户卡”。

## 11. 防回归检查

每次修改解析、agent 或审核台后至少确认：

```text
137 source inputs -> 137 sourceRequirements -> 137 一级卡
一 source 两 clauses -> 仍是一张一级卡
unsupported_by_solver + 0 row -> 卡片仍显示“已理解”
相同 rawText + 不同 sourceId -> 两张卡
source-only clarification -> 可继续
AI 重复 review -> 数量和 ID 集合不增长
system supplement -> 不计入 userInputCount
manual -> 只计入 manualInputCount
missing origin -> 归 unknown，不计入 userInputCount
sourceRequirements: [] -> 不回退 requirementItems/draftRows
source 一级卡 -> 显示完整原文，不被机器规则片段覆盖
侧边栏“要求待处理” -> 使用 source 数量，不使用 draftRows 数量
```

建议使用以下维护命令：

```bash
npm run audit:timetable:natural-language-137
npm run audit:timetable:market-language-local
npm run test:timetable:ai-golden
```

## 12. 市场语言 corpus 合同

统一 fixture 为 `test/fixtures/constraint-corpus.jsonl`。每行保留旧字段，并支持：

| 字段 | 含义 |
|---|---|
| `primaryCategory` / `categories` | 主要类别和交叉标签 |
| `expectedIntents` | intent/capability 兼容期望 |
| `expectedClauses` | 逐 clause 的对象、时间、参数、强度、否定和澄清真值 |
| `needsClarification` | 不得直接生成 ready 机器规则 |
| `unrecognized` | 明确领域外或不可识别输入 |
| `notes` | 人工审计理由，不参与 parser 输入 |

当前 corpus 为 205 句，六类新增市场语言各 15 句且均为主要目标。schema validator 必须拒绝重复 id、空文本、未知分类、无真值行和仅靠交叉标签虚增配额。

## 13. Shadow normalization

`normalizeTimetableMarketTextWithTrace()` 只生成 parser 内部理解文本和 `normalizationTrace`。以下字段始终基于原始输入：

```text
rawText
sourceId
textHash
审核台证据
```

映射必须是有边界的 phrase/token 规则，并同时具有正例和反例。不得用全局模糊替换修改教师名、班级名、学科名或普通文本。

## 14. 上下文与否定状态

- 教师、班级、学科和时间先行词只可在同一 `sourceId` 内继承。
- 新显式对象会更新对应类型上下文；多候选、缺失先行词或类型冲突进入 clarification。
- ConstraintIR 的 `negation` 保留 cues、scope、exception 和 polarity；“不能都”不得扩大为“全部不能”。
- 范围不确定、未知实体或 solver 不支持时，必须保留 SourceRequirement/IR，设置 `unsupported_by_solver` 或 `needs_clarification`，并保持 `machineRuleIds=[]`。

## 15. 真实 AI golden runner

命令：

```powershell
npm run test:timetable:ai-golden
npm run test:timetable:ai-golden -- c161,c178,c195
```

无 case 筛选时必须评测完整 205 句。runner 使用统一 fixture scorer，受控并发上限为 4，瞬时失败有限重试，并同时写出 `.tmp-timetable-ai-golden-latest.json` 与 `.md`。报告必须包含模型、prompt version、corpus hash、样本数、重试数、misses、覆盖率、字段准确率、source preservation/alignment 和 P95。

全量门槛固定为：coverage >=95%、field accuracy >=98%、P95 <=15s、source preservation=100%、source alignment=100%。
