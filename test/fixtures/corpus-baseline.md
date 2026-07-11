# Timetable Constraint Corpus Baseline

日期：2026-07-08

## 2026-07-11 扩充前冻结快照

- 扩充前 fixture：115 句；其中 107 句完成过真实 AI 验收，最近 8 句仅完成本地自动化验证。
- 扩充前 corpus SHA-256：`e71793eda67c847d900c64456bce23d0016ef6dcfafc624127dbaa34e653523d`。
- 真实 AI 历史模型：`deepseek-chat`（环境可通过 `DEEPSEEK_MODEL` / `OPENAI_MODEL` 覆盖）。
- 扩充起点 requirement extraction prompt version：`timetable_ai_requirement_extract_v4`。
- 此快照只用于证明扩充起点，不代表新增到 205 句后的真实 AI 验收结果。

## 覆盖率基线

- 当前语料规模：115 句；上一次真实 AI 验收覆盖其中 107 句。
- 结构覆盖：≥30 种意图、≥10 句需澄清、≥5 句无关内容、≥10 句多需求复合句。
- 目标覆盖率：≥ 95% 能结构化为规则、语义动作或澄清项。
- 当前自动化基线：无真实 AI key 时只校验 fixture 完整性、mock AI、实体对齐、编译器和降级链路。

## 字段准确率基线

- 目标字段准确率：≥ 98%。
- 字段范围：intent、对象、时间、参数、强度、澄清状态。
- 字段门禁：`test/timetable-ai-extraction.test.js` 内维护 `FIELD_EXPECTATIONS`，当前覆盖不少于 80 个对象/时间/参数/强度/澄清字段检查；真实 AI golden 开启时这些字段与 intent 一起计入字段准确率。
- 真实 AI 回归：`npm run test:timetable:ai-golden`，模型使用当前环境 DeepSeek 兼容配置，prompt version `timetable_ai_requirement_extract_v3`。

## 2026-07-08 真实 AI 验收

- 语料规模：107 句。
- 覆盖率：97.20%。
- 字段准确率：98.26%。
- P95 延迟：10.367s。
- 结论：达到覆盖率 ≥95%、字段准确率 ≥98%、P95 ≤15s 门槛。

## 2026-07-10 ConstraintIR / 137 条真实学校基线

- parser version：`timetable_rule_parser_constraint_ir_v6`；schemaVersion：2。
- 顶层来源不变量：userInputCount=137、sourceRequirements=137、唯一 sourceId=137。
- 语义/执行层当前基线：clauses=150、ConstraintIR=150、draftRows=127、唯一 machineRuleId=4、legacy requirementItems=150、semanticActions=2。
- 数量口径：只有 userInputCount/sourceRequirements 表示用户输入数；clauses、ConstraintIR、draftRows、requirementItems 允许因一条输入拆出多个语义或机器规则而与 137 不同。
- 正式审计：`npm run audit:timetable:natural-language-137`；根目录 `.tmp-audit-137.json` 当前记录 1970 项检查通过、0 项失败。
- 空项目实体上下文下 `statistics.machineRuleCount=4`、`statistics.draftRowCount=127`；123 个审核预览行继续可见，但不再伪装成机器规则。
- 第 131 行保留“隔天分布”和“不要挤在周四周五”两类能力；第 133 行跨场地边界保留为 1 个稳定 IR、0 个伪造机器规则。
- 真实 AI golden：107 句，覆盖率 97.20%，字段准确率 98.70%，P95 延迟 9.068s。
- 结论：达到覆盖率 ≥95%、字段准确率 ≥98%、P95 ≤15s 门槛。

## 2026-07-10 市场表达增量语料

- 当前 fixture 从 107 句扩充到 115 句。
- 新增覆盖：繁体/错字、`堂/堂课`、`头两堂课`、`末节`、`倒数第 N 节`、`最后两节`、`不方便/无法上课/请假`、逗号后同对象继承和新对象打断继承。
- 本次新增 8 句尚未纳入真实外部 AI 验收；最近一次真实 AI 指标仍只代表原 107 句，不能据此宣称 115 句全部通过。

## 2026-07-11 市场语言 205 句本地最终基线

- corpus：205 句；SHA-256 `ff22d5a11b12e8c71f1e567b32106f075f264b34f95ab1b54de5aae619ea2678`。
- 六类主要目标：colloquial/noisy_text/ellipsis/cross_sentence_reference/complex_negation/school_terminology 各 15 句。
- 本地确定性评测：语义覆盖率 100%、字段准确率 100%、source preservation 100%、source alignment 100%、0 failure。
- 正式报告：`test/fixtures/reports/timetable-market-language-local-final-2026-07-11.json` 与 `.md`。
- 当前 AI extraction prompt version：`timetable_ai_requirement_extract_v5`。
- v5 完整真实 AI 指标必须以包含模型、prompt version、corpus hash、205 样本、source preservation/alignment 和 P95 的新 runner 报告为准；历史 v3/v4 指标不得冒充 v5 最终验收。

## 2026-07-11 市场语言 205 句真实 AI 最终基线

- 模型：`deepseek-v4-flash`；prompt version：`timetable_ai_requirement_extract_v5`。
- corpus：完整 205 句；SHA-256 `ff22d5a11b12e8c71f1e567b32106f075f264b34f95ab1b54de5aae619ea2678`。
- 语义覆盖率：100%；字段准确率：100%。
- source preservation：100%；source alignment：100%。
- P95 延迟：13.383s；misses=0；retryCount=0；gateFailures=0。
- 权威报告：根目录 `.tmp-timetable-ai-golden-latest.json` 与 `.tmp-timetable-ai-golden-latest.md`。
- 结论：满足完整样本数 ≥200、覆盖率 ≥95%、字段准确率 ≥98%、P95 ≤15s、source 保留/对齐率 100% 的全部门槛。
