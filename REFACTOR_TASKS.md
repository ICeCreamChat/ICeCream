# REFACTOR_TASKS.md
# 代码整理任务书（供 Codex 执行）

> **阅读顺序：先读 `docs/architecture/SYSTEM.md` → `docs/architecture/MODULES.md` → 本文件。**
> **每次只做一个任务。做完跑测试，通过后再提交，再继续下一个。**

---

## 背景

当前代码库有几个体积过大、职责混杂的服务文件，难以维护。本文件列出具体拆分方案，每个任务都包含：要拆什么、拆成哪几个文件、每个文件放哪些函数、验证方法。

**绝对原则：**
- 拆分只移动代码，不改逻辑
- 每个任务完成后 `npm test` 必须全量通过
- 不改任何已有函数的签名（参数和返回值保持不变）
- 新文件命名遵循已有风格：`timetable-xxx-yyy.js`、`seating-xxx.js`

---

## 任务优先级

| 优先级 | 任务 | 文件 | 行数 | 风险 |
|--------|------|------|------|------|
| P1 | 拆分排课规则解析器 | timetable-rule-parser.js | 11,897 | 高 |
| P2 | 拆分座位安排编排器 | seating-arrange.js | 3,055 | 中 |
| P3 | 拆分排课诊断调度器 | timetable-diagnostic-scheduler.js | 2,741 | 中 |
| P4 | 拆分 AI 约束提取器 | timetable-ai-extractor.js | 2,304 | 中 |
| P5 | 清理遗留代码 | 多文件 | - | 低 |

---

## P1：拆分 timetable-rule-parser.js（11,897 行）

### 现状分析

`timetable-rule-parser.js` 包含 354 个内部函数 + 10 个导出函数，承担了 6 个独立职责：

| 职责 | 代表函数（私有）| 行数范围（约）|
|------|----------------|--------------|
| 解析缓存管理 | `parseCacheKey`, `getParseCache`, `setParseCache`, `parseWithPersistentCache` | 165–350 |
| 源文本输入准备 | `sourceRowsForParse`, `prepareSourceInputs`, `parserActors` | 352–430 |
| Artifact 构建 | `artifactProvenance`, `constraintArtifactFromRow`, `semanticConstraintArtifact`, `fallbackConstraintArtifact` | 430–800 |
| 告警聚合 | `aggregateSourceWarnings`, `buildWarningItems`, `semanticRationalesFromText` | 485–580 |
| 约束 IR 编译 | `mergeConstraintIR`, `compactCapabilityIRs`, `warningsForConstraintExecution` | 776–960 |
| 主解析流程（编排） | `parseTimetableRules` 及其他 9 个导出函数 | 5170–11897 |

### 目标：拆成 5 个文件

#### 新文件 1：`gateway/services/timetable-rule-parser-cache.js`
**职责**：解析结果缓存（内存 + 持久化）
**从 timetable-rule-parser.js 移入的函数：**
- `parseCacheKey`
- `getParseCache`
- `setParseCache`
- `persistentParseCacheEnabled`
- `parseWithPersistentCache`
- `determinismMetadata`
- `cacheConstraintIRSignature`
- `parseResultPassesCacheAdmission`
- `withParseMetadata`
- `projectFingerprintForParse`
- `aiReviewDisabled`
- `aiReviewTimeoutMs`
- `aiReviewCachePart`

**新增导出**（供 timetable-rule-parser.js 调用）：
```js
export { parseCacheKey, getParseCache, setParseCache, parseWithPersistentCache,
         determinismMetadata, withParseMetadata, parseResultPassesCacheAdmission,
         persistentParseCacheEnabled }
```

#### 新文件 2：`gateway/services/timetable-rule-parser-sources.js`
**职责**：解析输入的规范化与来源追踪
**从 timetable-rule-parser.js 移入的函数：**
- `sourceRowsForParse`
- `prepareSourceInputs`
- `parserActors`
- `normalizedTextValues`
- `normalizedMessageValues`
- `normalizedParsedBy`
- `asList`

**新增导出：**
```js
export { sourceRowsForParse, prepareSourceInputs, parserActors }
```

#### 新文件 3：`gateway/services/timetable-rule-parser-artifacts.js`
**职责**：约束 Artifact 构建（将解析结果包装成带溯源的 artifact 对象）
**从 timetable-rule-parser.js 移入的函数：**
- `artifactProvenance`
- `constraintArtifactFromRow`
- `semanticConstraintArtifact`
- `ensureCapabilityArtifactSourceIdentity`
- `fallbackConstraintArtifact`
- `aggregateSourceWarnings`
- `buildWarningItems`
- `semanticRationalesFromText`
- `enrichSemanticActions`
- `mergeSystemSupplements`
- `uniqueConstraintMessages`

**新增导出：**
```js
export { artifactProvenance, constraintArtifactFromRow, semanticConstraintArtifact,
         fallbackConstraintArtifact, aggregateSourceWarnings, buildWarningItems }
```

#### 新文件 4：`gateway/services/timetable-rule-parser-ir.js`
**职责**：约束中间表示（IR）的合并、压缩与校验
**从 timetable-rule-parser.js 移入的函数：**
- `mergeConstraintIR`
- `compactCapabilityIRs`
- `warningsForConstraintExecution`
- `usableSemanticObject`
- `requirementMatchesCompiledRow`
- `requirementForCompiledRow`

**新增导出：**
```js
export { mergeConstraintIR, compactCapabilityIRs, warningsForConstraintExecution }
```

#### 保留在 timetable-rule-parser.js
**只保留 10 个原有导出函数**（编排逻辑），以及直接服务于它们的少量私有辅助函数。
其余 300+ 私有函数已移走，此文件应压缩到 2,000 行以内。

### 操作步骤

1. 读取 timetable-rule-parser.js 全文，确认上述函数确实存在且位置正确
2. 创建 4 个新文件，每次把对应函数剪切进去（保持函数体完全不变）
3. 在 timetable-rule-parser.js 顶部 `import` 新文件导出的函数（替换原先的内部调用）
4. 删除 timetable-rule-parser.js 中已移走的函数定义
5. 运行 `npm test`，确保全量通过
6. 提交：`refactor(timetable): split rule-parser into 4 focused modules`

### 验证命令
```bash
npm test
# 重点关注：
# test/timetable-rule-parser.test.js
# test/timetable-rule-parser-source-identity.test.js
# test/timetable-constraint-ir-137.test.js
```

---

## P2：拆分 seating-arrange.js（3,055 行）

### 现状分析

`seating-arrange.js` 混合了 4 个独立职责：

| 职责 | 代表函数 | 行数范围（约）|
|------|---------|--------------|
| 请求与规格规范化 | `normalizeArrangeRequest`, `normalizeArrangementSpec`, `normalizeLayoutPlan` | 69–500 |
| 布局生成（AI + 本地）| `runAiLayoutPreview`, `buildLocalArrangement`, `buildPreviewLayoutFromSpec` | 500–1500 |
| 学生座位分配 | `assignStudentsToLayout`, `assignLocalSeats`, `chooseGuardians` | 1500–2500 |
| 分数优化与精炼 | `optimizeSeatingScore`, `refineSeatingAssignments` | 2400–2800 |
| 顶层编排（入口）| `runAiDrivenArrangement`, `requestAiArrangement` | 2800–3055 |

### 目标：拆成 4 个文件

#### 新文件：`gateway/services/seating-arrange-spec.js`
**移入：** `normalizeArrangeRequest`, `normalizeArrangementSpec`, `normalizeLayoutPlan`,
`validateLayoutPlan`, `shouldAllowUnassigned`, `strategyOverrideWarnings`, `appliedStrategiesFor`

**导出：** 上述所有函数

#### 新文件：`gateway/services/seating-arrange-layout.js`
**移入：** `runAiLayoutPreview`, `buildLocalArrangement`, `buildPreviewLayoutFromSpec`,
`buildArrangeMessages`, `parseAiJson`, `isAiJsonParseError`, `buildArrangeRepairPrompt`

**导出：** `runAiLayoutPreview`, `buildPreviewLayoutFromSpec`

#### 新文件：`gateway/services/seating-arrange-assignment.js`
**移入：** `assignStudentsToLayout`, `assignLocalSeats`, `chooseGuardians`,
`optimizeSeatingScore`, `refineSeatingAssignments`, `buildArrangementInterpretation`,
`validateAiArrangement`, `buildAiRepairMessages`

**导出：** `assignStudentsToLayout`, `validateAiArrangement`

#### 保留在 seating-arrange.js
**只保留：** `runAiDrivenArrangement`, `requestAiArrangement` 及必要的 import
目标：从 3055 行压缩到 300 行以内

### 验证命令
```bash
npm test
# 重点关注：
# test/seating-arrange.test.js
# test/seating-arrange-route.test.js
```

---

## P3：拆分 timetable-diagnostic-scheduler.js（2,741 行）

### 现状分析

此文件混合了本地排课算法和诊断调度两个完全独立的功能。

| 职责 | 关键导出 |
|------|---------|
| 本地排课算法 | `runTimetableScheduler`, `buildSchedulingUnits` |
| 可行性分析 | `analyzeTimetableFeasibility` |
| 冲突组件构建 | `buildConflictComponent` |

### 目标：拆成 2 个文件

#### 新文件：`gateway/services/timetable-local-scheduler.js`
**移入：** `runTimetableScheduler`, `buildSchedulingUnits` 及其所有私有辅助函数
（约 200 个私有函数，占文件主体）

**导出：** `runTimetableScheduler`, `buildSchedulingUnits`

#### 保留在 timetable-diagnostic-scheduler.js
**只保留：** `analyzeTimetableFeasibility`, `buildConflictComponent` 及诊断相关辅助函数
目标：从 2741 行压缩到 800 行以内

### 验证命令
```bash
npm test
# 重点关注：
# test/timetable-scheduler.test.js
# test/timetable-diagnostics.test.js
```

---

## P4：拆分 timetable-ai-extractor.js（2,304 行）

### 现状分析

| 职责 | 关键导出 |
|------|---------|
| AI 提取入口 | `extractRequirementsWithAI` |
| 提取结果校验 | `validateExtractionPayload` |
| 实体引用解析 | `resolveEntityRefs` |
| Prompt 构建 | `buildAiExtractionPromptProjectForTests` |
| 缓存管理 | `resetTimetableAiExtractionCache`, `getTimetableAiExtractionCacheStats` |

### 目标：拆成 2 个文件

#### 新文件：`gateway/services/timetable-ai-extraction-validator.js`
**移入：** `validateExtractionPayload`, `resolveEntityRefs` 及其私有校验辅助函数

**导出：** `validateExtractionPayload`, `resolveEntityRefs`

#### 保留在 timetable-ai-extractor.js
**只保留：** `extractRequirementsWithAI`, `buildAiExtractionPromptProjectForTests`,
缓存管理函数，以及 AI 调用相关逻辑
目标：从 2304 行压缩到 1200 行以内

### 验证命令
```bash
npm test
# 重点关注：
# test/timetable-ai-extraction.test.js
# test/timetable-ai-source-alignment.test.js
```

---

## P5：清理遗留代码

### 5a. gateway/services/timetable-constraint-conversation.js（941 行）

检查是否与 `gateway/services/timetable-agent/` 子系统有功能重叠。

- 若功能已被 timetable-agent-core.js 完全覆盖 → 标记废弃，在依赖方加 TODO，等下一版移除
- 若仍被 gateway/routes/timetable.js 引用 → 保留，但在文件顶部加说明注释

**操作：**
```bash
grep -rn "timetable-constraint-conversation" gateway/ test/
```
若只有少量引用，评估是否可并入 timetable-agent-core.js。

### 5b. services/（根目录）与 gateway/services/ 的重复风险

`services/` 根目录下的文件（chat-handler.js、manim-client.js、solver-handler.js）由 gateway/middleware/intent-router.js 动态 import。

**检查：**
```bash
ls services/
grep -rn "from.*'../../services/" gateway/
```

确认这些文件没有与 gateway/services/ 下的同名文件产生混淆。若有重复实现，合并至 gateway/services/。

### 5c. 删除根目录临时文件

以下文件如果仍存在，应直接删除（无引用的临时产物）：
- `timetable_inspector_refactor_plan.md`（私有规划文档，不应进 git）

---

## 通用注意事项

### 每次拆分的操作顺序

```
1. git stash（确保工作区干净）
2. 只做一个任务
3. npm test（必须全量通过，不允许有 fail）
4. git add -A && git commit（按 Conventional Commits 格式）
5. 继续下一个任务
```

### 遇到循环依赖怎么办

如果新文件 A 需要导入新文件 B，B 又要导入 A：
- 找出两者共用的纯工具函数，提取到第三个文件 `*-utils.js`
- 不要为了消除循环依赖而改变函数签名

### 改完某文件后必须检查的调用方

```bash
# 以 timetable-rule-parser.js 为例，找所有 import 它的文件
grep -rn "from.*timetable-rule-parser" gateway/ test/
```

确保所有调用方的 import 路径和函数名都能在新结构下解析。

### 提交格式

```
refactor(timetable): split rule-parser into focused modules

What changed:
- Extracted cache layer into timetable-rule-parser-cache.js (~200 lines)
- Extracted artifact builders into timetable-rule-parser-artifacts.js (~400 lines)
- ...（列出每个新文件）

Impact:
- No behavior change; all 10 public exports and their signatures unchanged
- timetable-rule-parser.js reduced from 11897 to ~2000 lines

Validation:
- npm test: all N tests pass
```

---

## 验收标准

每个任务完成后，需满足：

- [x] `npm test` 无 fail（1279 个用例，至少 1278 通过）
- [x] 拆分后原文件行数符合目标（P1 < 2000行，P2 < 300行，P3 < 800行，P4 < 1200行）
- [x] 所有原有导出函数签名不变（同名、同参数、同返回结构）
- [x] 无新增的跨模块依赖（seating 不引用 timetable，反之亦然）
- [x] `docs/architecture/MODULES.md` 中对应模块卡片已更新文件路径

---

*由 Claude Fable 5 生成于 2026-07-26，基于仓库实际代码扫描。*
