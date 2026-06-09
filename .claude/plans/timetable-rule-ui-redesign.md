# AI 约束交互重设计方案：卡片列表 + 内联编辑

## 设计理念

抛弃现有的「功能过载弹窗」，改为 **侧边栏内一体化** 的卡片式交互：
- 输入区始终可见在顶部（文本框 + 上传 + AI 解析按钮）
- AI 解析结果作为「待确认卡片」追加到列表顶部，用户逐条接受/拒绝/编辑
- 已生效规则作为紧凑卡片列在下方，可内联删除或查看详情
- 不再有 dialog / modal —— 所有操作在侧边栏流内完成

这对标 Notion 属性面板 / Linear 任务属性的「所见即所得」模式，信息密度高但不阻塞主视图。

## 现状问题清单

| # | 问题 | 影响 |
|---|---|---|
| 1 | 一个 dialog 承载 input/review/saved 三种状态，按钮含义随状态变化 | 用户迷路 |
| 2 | 复核表有 8 列（含原始文本、技术枚举），横向溢出 | 小屏不可用 |
| 3 | 必须完成整个复核流程才能退出 dialog，中途无法看课表 | 操作阻塞 |
| 4 | 「手动批量」tab 和 AI 解析混在同一 dialog 输入步骤 | 概念混淆 |
| 5 | state 里 7 个顶层字段与 `ruleReview` 子对象重复 | 维护成本 |
| 6 | 已保存规则要点卡片进 dialog 才能看 | 信息不透明 |

## 新设计详细方案

### A. 侧边栏「AI 约束」面板新布局

```
┌─── AI 约束 ────────────────────┐
│                                  │
│ ┌─ 输入区 ─────────────────────┐ │
│ │ [文本框] placeholder 示例     │ │
│ │ [附件: constraints.xlsx  ×]  │ │
│ │ ──────────────────────────── │ │
│ │ [AI 解析 ▸]  [手动添加 +]   │ │
│ └──────────────────────────────┘ │
│                                  │
│ ┌─ 待确认 (3) ─────────────────┐ │
│ │ ┌──────────────────────────┐ │ │
│ │ │ ⚡ 教师不可排              │ │ │
│ │ │ 王老师 · 周三 3-5,3-6,3-7│ │ │
│ │ │ 硬性 · 置信度 95%         │ │ │
│ │ │         [✓ 接受] [✗ 拒绝] │ │ │
│ │ └──────────────────────────┘ │ │
│ │ ┌──────────────────────────┐ │ │
│ │ │ ⚡ 课程上午优先            │ │ │
│ │ │ 数学                      │ │ │
│ │ │ 软性 · 置信度 90%         │ │ │
│ │ │         [✓ 接受] [✗ 拒绝] │ │ │
│ │ └──────────────────────────┘ │ │
│ │ ┌──────────────────────────┐ │ │
│ │ │ ⚠️ 教师负载均衡（仅建议） │ │ │
│ │ │ 全部教师                  │ │ │
│ │ │ 暂不支持                  │ │ │
│ │ │                [忽略 ×]   │ │ │
│ │ └──────────────────────────┘ │ │
│ │ ─────────── 或 ──────────── │ │
│ │ [全部接受]  [全部拒绝]      │ │
│ └──────────────────────────────┘ │
│                                  │
│ ┌─ 已生效 (5) ─────────────────┐ │
│ │ 王老师 · 周三不排 · 硬性  [×]│ │
│ │ 数学 · 上午优先 · 软性    [×]│ │
│ │ 英语 · 上午优先 · 软性    [×]│ │
│ │ 体育 · 同科分散 · 软性    [×]│ │
│ │ 李老师 · 每日≤3节 · 软性  [×]│ │
│ └──────────────────────────────┘ │
│ [清空全部规则]                   │
└──────────────────────────────────┘
```

### B. 交互流程

1. **输入**：用户在侧边栏顶部文本框写自然语言 / 选文件 / 点示例 chip
2. **解析**：点「AI 解析」按钮 → loading → 返回 draftRows
3. **卡片追加**：draftRows 渲染为「待确认」区的卡片列表（非 dialog，就在侧边栏内）
4. **逐条确认**：
   - 点「✓ 接受」→ 该条立即调用 POST /rules/normalize → POST /rules 写入 → 从待确认移到已生效
   - 点「✗ 拒绝」→ 直接从待确认移除（不写入）
   - 点卡片展开 → 内联编辑对象/节次/优先级（不用 dialog）
5. **批量操作**：「全部接受」/ 「全部拒绝」一键处理
6. **手动添加**：点「手动添加 +」→ 在待确认区追加一张空白可编辑卡片
7. **已生效管理**：已保存规则以紧凑一行显示，每条可内联删除

### C. 状态模型简化

```js
ruleReview: {
    loading: false,         // AI 解析中
    text: '',               // 输入框内容
    fileName: '',           // 上传文件名
    pendingCards: [],       // 待确认卡片（AI 解析后的 draftRows）
    expandedCardId: null,   // 当前展开编辑的卡片 id
}
// 删除: ruleDraft, ruleDraftPreview, ruleWarnings, ruleFileName,
//       ruleDraftInputType, ruleContextStats, ruleUnsupportedItems
// 已保存规则直接从 project.rules 派生 (getSavedRuleItems)
```

### D. 卡片视觉设计

每张「待确认」卡片：
- 左侧：彩色竖条（硬性=红，软性=蓝，仅建议=灰）
- 第一行：类型标签（中文） + 置信度 badge（如 95%）
- 第二行：对象名 · 节次描述
- 第三行：操作按钮（接受 / 拒绝 / 展开编辑）
- 展开态：显示可编辑字段（对象下拉、节次选择器、强弱切换）

每张「已生效」行：
- 单行：对象 · 类型描述 · 强弱 tag · 删除按钮
- hover 展开查看详情

### E. 实施文件清单

| 文件 | 改动 |
|---|---|
| `state.js` | 简化 ruleReview；删除 7 个顶层冗余字段 |
| `view.js` | 删除 renderRuleReviewDialog / renderRuleReviewInput / renderRuleReviewTable / renderRuleReviewRow / renderRulePreview；新增 renderRuleInputArea / renderPendingCards / renderSavedRuleList / renderRuleCard |
| `controller.js` | 删除 openRuleReview / closeRuleReview / setRuleReviewMode / setRuleReviewState / readRuleReviewRows / updateRuleReviewField / confirmRuleDraft（整套 dialog 逻辑）；新增 parseRulesInline / acceptRule / rejectRule / acceptAllRules / rejectAllRules / toggleRuleCardExpand / updatePendingCard / addManualRule / deleteRule |
| `grid-interactions.js` | 移除 dialog 相关绑定；新增卡片按钮绑定 |
| `selectors.js` | getSavedRuleItems 保留；可能需微调 |
| `timetable-planner.css` | 删除 .tt-rule-review-dialog / .tt-dialog-overlay 相关样式；新增 .tt-rule-input-area / .tt-pending-card / .tt-rule-card / .tt-saved-rule-row 等 |
| `forms.js` | 可能简化（手动构建器内联到卡片编辑态） |
| 路由/后端 | 不变（POST /rules/parse、/rules/normalize、/rules 都保留） |
| 测试 | UI 测试大幅更新（dialog 断言全部替换为卡片断言），但后端测试完全不变 |

### F. 后端 API 调用不变

- 解析：POST `/rules/parse` → 返回 draftRows（和现在一样）
- 逐条确认：POST `/rules/normalize` { draftRows: [单条] } → POST `/rules` → 更新 project
- 批量确认：POST `/rules/normalize` { draftRows: 全部 pending } → POST `/rules`
- 删除单条：读当前 project.rules → 移除对应条目 → POST `/rules` 覆盖写入

### G. 渐进迁移策略

由于 UI 测试强耦合到 dialog 元素（`#tt-rule-review-dialog`、`data-rule-review-row`、`data-rule-review-field` 等），这次重写会改变大量 DOM 结构。策略：
1. 保持后端 API 契约完全不变
2. 保持 controller 的公开方法名语义（如 `parseRules` 仍叫这名）
3. UI 测试全面更新为新断言（卡片 id/class、按钮存在性等）
4. 分两阶段：先实现新渲染 + 状态逻辑 → 再删旧代码 + 更新测试

### H. 与排课表的关系

侧边栏 AI 约束面板和排课表主面板共存，不再有 dialog 遮挡。用户可以一边看课表一边管理约束，解析完直接看效果。这是体验的最大提升。
