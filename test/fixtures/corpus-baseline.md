# Timetable Constraint Corpus Baseline

日期：2026-07-08

## 覆盖率基线

- 语料规模：107 句。
- 结构覆盖：≥30 种意图、≥10 句需澄清、≥5 句无关内容、≥10 句多需求复合句。
- 目标覆盖率：≥ 95% 能结构化为规则、语义动作或澄清项。
- 当前自动化基线：无真实 AI key 时只校验 fixture 完整性、mock AI、实体对齐、编译器和降级链路。

## 字段准确率基线

- 目标字段准确率：≥ 98%。
- 字段范围：intent、对象、时间、参数、强度、澄清状态。
- 字段门禁：`test/timetable-ai-extraction.test.js` 内维护 `FIELD_EXPECTATIONS`，当前覆盖不少于 80 个对象/时间/参数/强度/澄清字段检查；真实 AI golden 开启时这些字段与 intent 一起计入字段准确率。
- 真实 AI 回归：`npm run test:timetable:ai-golden`，模型使用当前环境 DeepSeek 兼容配置，prompt version `timetable_ai_requirement_extract_v2`。

## 2026-07-08 真实 AI 验收

- 语料规模：107 句。
- 覆盖率：97.20%。
- 字段准确率：98.26%。
- P95 延迟：10.367s。
- 结论：达到覆盖率 ≥95%、字段准确率 ≥98%、P95 ≤15s 门槛。
