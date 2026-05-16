# Manim 真实 Smoke 验收记录

审计时间：2026-05-16  
运行环境：Python 3.12.8 + Manim Community 0.20.1  
命令模式：单 case 顺序运行，`--strict-quality`

## 基础测试

| 项目 | 命令 | 结果 |
|---|---|---|
| Python 单元测试 | `manim-service\.venv\Scripts\python.exe -m unittest discover manim-service/tests` | 80 tests OK |
| 前端/Gateway Manim 测试 | `npm test -- test/manim-agent.test.js test/manim-env-check.test.js test/manim-suggestions.test.js` | 22 tests OK |

## 6 Prompt Smoke

| Case | Prompt | 结果 | Strict Quality | Quality Score | Repair | Code Source | Video |
|---|---|---:|---:|---:|---:|---|---|
| circle | 画一个圆形 | passed | passed | 100 | 0 | llm_v6 | `/static/video_d0bce7ed.mp4` |
| square | 画一个正方形 | passed | passed | 100 | 0 | llm_v6 | `/static/video_3fbadd20.mp4` |
| triangle | 画一个三角形 | passed | passed | 100 | 0 | llm_v6 | `/static/video_10ac15b6.mp4` |
| sine | 画一个正弦函数，做分步骤讲解动画 | passed | passed | 96 | 1 | repair | `/static/video_bb950a78.mp4` |
| bar-chart | 画一个三个月销量柱状图 | passed | passed | 100 | 0 | llm_v6 | `/static/video_a38aeeba.mp4` |
| tcp-flow | 解释 TCP 三次握手流程 | passed | passed | 100 | 0 | llm_v6 | `/static/video_5df5a26c.mp4` |

## 汇总

- passed：6/6
- strictQualityPassed：6/6
- rescueCount：0
- minimumQualityScore：96
- repairCount：`sine = 1`，其它 case 为 0

## 与历史 latest smoke 的差异

`logs/manim-agent-smoke-latest.json` 中 `tcp-flow` 曾失败：

- 失败摘要：`peer closed connection without sending complete message body (incomplete chunked read)`
- 单独重跑 `tcp-flow` 后通过，质量分 100，repairCount 0。
- 结论：这是上游/流式传输瞬态失败，需要 retry 和中文诊断，不应视为 TCP prompt 固定失败。

## 下一步回归建议

- 每次修复 P0 JSON-safe 问题后，重新跑 6 prompt strict smoke。
- 每次修改视觉检查阈值后，至少跑：`sine`、`triangle`、`tcp-flow`、`等差数列推导`。
- `sine` 的 repairCount 应继续压到 0，作为精品状态的下一门槛。
