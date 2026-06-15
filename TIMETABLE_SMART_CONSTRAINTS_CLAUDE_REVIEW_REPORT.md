# 智能排课智能约束工作台重构审查报告

> 供 Claude 审查使用。审查范围只限 ICeCream 课堂工具箱中的「智能排课」模块，不应扩散到排座模块。

## 1. 审查目标

本轮目标是把原来的「智能约束弹窗/复核表/智能助手」从堆叠式界面，重构为小白可理解的「智能排课助手工作台」。

核心用户路径：

1. 打开智能排课助手。
2. 检查排课数据。
3. 描述或上传约束。
4. 智能理解约束。
5. 按办理事项处理问题。
6. 核对将要生效的规则。
7. 确认写入项目规则。
8. 进入求解计划、生成课表、诊断/保存。

保留约束：

- 不改排座模块。
- 不推翻现有本地快排算法。
- 不新增后端主路由。
- 继续复用 `/rules/*`、`/constraints/*`、`/schedule/*`、`/agent/*`。
- 智能助手只能解释、预览和修改草稿，不能绕过确认直接保存规则。

## 2. 本轮主要改动

### 2.1 独立智能排课助手工作台

新增独立工作台渲染模块：

- `public/js/tools/timetable/smart-workbench/workbench-view.js`
- `public/js/tools/timetable/smart-workbench/workbench-components.js`
- `public/js/tools/timetable/smart-workbench/workbench-state.js`
- `public/js/tools/timetable/smart-workbench/constraint-adapter.js`
- `public/js/tools/timetable/smart-workbench/render-scheduler.js`
- `public/css/timetable-smart-workbench.css`

工作台布局：

- 桌面端：左侧步骤栏 / 中间当前任务 / 右侧当前情况与智能助手。
- 移动端：单列纵向布局，步骤栏横向滚动。
- 旧的 `#tt-rule-review-dialog` 不再作为主入口出现。

### 2.2 左栏入口小白化

涉及文件：

- `public/js/tools/timetable/view.js`
- `public/js/tools/timetable/controller.js`
- `public/js/tools/timetable/grid-interactions.js`

行为变化：

- 左栏只保留智能约束入口和摘要，不显示规则长列表。
- 有任课数据但没有课表时，默认展开「智能约束」分组，让用户直接看到入口。
- 点击入口打开独立工作台。
- 打开工作台后自动滚到顶部，修复移动端进入后顶部步骤栏被截掉的问题。

### 2.3 约束复核从表格改为办理清单

新复核方式：

- `核对可直接应用`
- `核对需要确认`
- `确认课程名称`
- `确认教师名称`
- `确认班级名称`
- `确认名称`
- `修正节次范围`
- `处理冲突风险`
- `查看暂不支持建议`
- `查看已生效约束`

重要变化：

- 默认展示自然语言卡片，不再默认铺开高级表格。
- 高级编辑仍保留，并延迟渲染，保留 `data-rule-review-row` / `data-rule-review-field`。
- 解析详情默认折叠，不再把 raw warnings 长条铺满页面。
- 规则来源从内部标识 `ai` 转换为用户可读的 `智能解析`。

### 2.4 局部渲染与卡顿治理

涉及文件：

- `public/js/tools/timetable/controller.js`
- `public/js/tools/timetable/smart-workbench/render-scheduler.js`

实现点：

- 新增 `createRenderScheduler()` 合并重复局部刷新。
- `renderSmartWorkbenchSurface()` 只替换工作台根节点，不重绘整个课表网格。
- 智能助手输入、任务切换、扫描结果更新都走局部渲染路径。
- 工作台打开/解析/确认过程保留滚动和焦点状态。

### 2.5 智能助手内嵌化

涉及文件：

- `public/js/tools/timetable/controller-chat-extension.js`
- `public/js/tools/timetable/controller-smart-helper.js`
- `public/js/tools/timetable/view-chat.js`
- `public/js/tools/timetable/smart-workbench/workbench-view.js`

行为变化：

- 智能助手不再作为独立大遮罩聊天弹窗使用。
- 助手固定在工作台右侧或移动端下方。
- 任务卡可携带 `taskContext` 调用助手。
- 修复建议必须先生成预览，用户确认后才应用到草稿。

### 2.6 Agent Planner 兜底

新增：

- `gateway/services/timetable-agent/timetable-agent-planner.js`

作用：

- 将用户意图映射到白名单工具。
- 输出下一工具、原因、风险、是否需要确认。
- 保留正则意图识别作为无模型兜底。

## 3. 关键审查点

请 Claude 重点检查这些问题。

### 3.1 是否仍有旧弹窗入口残留

期望：

- 主路径不应再打开 `#tt-rule-review-dialog`。
- 智能约束应进入 `[data-smart-workbench-root]`。

建议审查：

- `public/js/tools/timetable/controller.js`
- `public/js/tools/timetable/view.js`
- `public/js/tools/timetable/grid-interactions.js`

特别看：

- 是否还有调用旧 `renderRuleReviewDialog(state)` 的路径。
- 旧 CSS 是否仍会影响新工作台。
- 旧函数存在但不可达是否可以接受，或需要后续清理。

### 3.2 局部渲染是否真的避免课表重绘

期望：

- 助手输入、任务切换、扫描、预览不应触发整页 `render()`。
- 只有项目级数据变化、关闭工作台、生成课表等需要完整刷新。

建议审查：

- `renderSmartWorkbenchSurface()`
- `requestSmartRender()`
- `createRenderScheduler()`
- `controller-chat-extension.js`
- `controller-smart-helper.js`

风险：

- 某些路径仍可能调用 `this.render()`，导致大项目卡顿。
- `current.replaceWith(next)` 会替换整个工作台，虽然不重绘课表，但仍可能对超长草稿有成本。

### 3.3 办理清单统计是否一致

期望：

- 右侧「需处理」数量、顶部 section 数量、办理清单任务数量应一致或可解释。
- `groups.review`、`clarifyingQuestions`、`missingInfo`、`conflicts`、`unsupportedItems` 不应重复计数过多。

建议审查：

- `groupWorkbenchConstraints()`
- `renderReviewTaskChecklist()`
- `countQuestionsByTarget()`
- `genericQuestionCount()`
- `slotIssueCount()`

刚修过的问题：

- 有 `groups.review` 但办理清单没有对应入口，已补 `核对需要确认`。

### 3.4 规则保存闭环是否仍安全

期望：

- 未确认前不保存项目规则。
- `确认生效` 仍走 `/rules/normalize` 和 `/rules`。
- 建议项、暂不支持、无效项不能写入。
- 助手应用预览只修改草稿，不直接保存项目。

建议审查：

- `previewSmartRuleChanges()`
- `confirmRuleDraft()`
- `applyConstraintChatPreview()`
- `buildRuleChangePreview()`
- `readRuleReviewRows()`

### 3.5 移动端可用性

已做浏览器检查：

- 桌面 1440x950：无旧弹窗、无横向溢出。
- 移动 390x844：无旧弹窗、无横向溢出。
- 打开工作台会滚到顶部。

建议继续人工检查：

- 上传文件入口是否足够明显。
- 步骤栏横向滚动是否自然。
- 办理清单数量多时是否过长。
- 智能助手在移动端是否需要改成真正底部抽屉。

## 4. 已运行验证

已通过：

```powershell
node --test test\timetable-planner-ui.test.js
node --test test\timetable-smart-workbench.test.js
npm.cmd test
.\dev.bat --check
cd solver && .\mvnw.cmd test
git diff --check
```

验证结果：

- `npm.cmd test`: 618 pass
- Solver: 24 pass
- `dev.bat --check`: pass
- `git diff --check`: 仅 CRLF 提示，无空白错误

浏览器实测：

- 使用本机 Chrome + Playwright 包，访问 `http://localhost:3000`。
- 从课堂工具箱进入智能排课。
- 打开智能排课助手。
- 粘贴中文约束并解析。
- 确认进入办理清单，显示规则卡片和名称确认任务。
- 没有出现旧 `#tt-rule-review-dialog`。
- 解析后规则卡片显示 `来源：智能解析`，不显示 `来源：ai`。

## 5. 当前工作区状态提醒

当前 `git status` 中有以下需要确认的状态：

- `README.md` 显示为删除。
- `timetable-smart-constraints-refactor.md` 显示为删除。

这两个删除状态不属于本报告重点审查范围。请 Claude 或人工确认是否为预期变更，不要在不了解原因时直接回滚。

新增/主要修改文件集中在：

- `gateway/services/timetable-agent/*`
- `public/js/tools/timetable/*`
- `public/js/tools/timetable/smart-workbench/*`
- `public/css/timetable-smart-workbench.css`
- `public/css/timetable-planner.css`
- `test/timetable-*.test.js`

未看到排座核心实现文件出现在当前 diff 列表中。

## 6. 建议 Claude 给出的审查结论格式

请 Claude 按以下结构审查：

1. 阻塞问题  
   会导致无法使用、保存错误、规则错误写入、排座被误改、课表被错误覆盖的问题。

2. 高风险问题  
   会造成卡顿、状态错乱、移动端不可用、智能助手误导用户的问题。

3. 中低风险问题  
   文案不清楚、布局可优化、旧代码可清理、测试覆盖可补充。

4. 建议补充测试  
   特别是浏览器/E2E、长草稿性能、移动端、助手预览应用。

5. 是否建议合入  
   给出 `可以合入 / 需要修复后合入 / 不建议合入`。

## 7. 我希望 Claude 特别挑刺的问题

- 新工作台是否真的比旧弹窗更适合小白。
- 是否还有「题目式」问答感太强的问题。
- 右侧智能助手是否真的有帮助，而不是只显示固定文案。
- 大量 draftRows 时是否需要虚拟列表或分页。
- 旧 `view.js` 中保留的兼容函数是否应该在下一阶段彻底删除。
- `timetable-agent-planner.js` 中正则意图识别是否足够稳，是否存在误判。
- 当前中文文案是否有工程味或内部术语残留。

## 8. 下一阶段建议

如果本轮审查通过，下一阶段建议只做三件事：

1. 清理旧不可达代码  
   删除旧 rule review dialog 和旧 smart-helper 独立大弹窗相关实现。

2. 补浏览器自动化测试  
   用真实浏览器跑：打开工作台、粘贴约束、解析、处理确认、保存规则。

3. 优化长草稿性能  
   对 100+ 条约束草稿使用分区分页或虚拟列表，避免一次渲染所有卡片。
