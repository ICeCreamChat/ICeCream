# 智能约束助手自然语言排课建模整体计划

## 目标

把智能约束助手从“识别几类约束”升级为“自然语言排课需求建模器”：

- 先理解用户说的是哪个对象、什么需求、什么条件、什么强度。
- 再判断需求应落到约束规则、任课计划、软优化目标、求解器内置策略、发布校验或导出展示。
- 能确定的自动生成可应用动作；不确定的进入对话追问和人工确认。
- 不假装支持：模型、求解器、发布、导出没有真正吃到的能力，必须明确标记为待扩展或需复核。

## 总体判断

这是一个大流程，不是单点 parser 修复。

它会影响：

- 前端：智能约束助手、已理解需求审核台、追问确认、手动填写、上传文件、应用前预览。
- 后端：自然语言 parser、xlsx parser、语义层、应用端点、项目模型校验。
- 数据模型：单双周、多校区、命名教学组、合班/走班、通勤间隔、教室/场地属性。
- 求解器：任务展开、资源占用、冲突检测、修复、局部优化、复杂规则评分。
- 发布导出：单双周视图、校区/教室/教学组展示、发布前校验。

## 已确认产品原则

- 成功标准是“理解优先”：尽量理解自然语言，不能确定时追问，不要硬猜。
- 三个入口统一：对话输入、xlsx 上传、手动填写都进入同一套语义引擎。
- 复杂模型要纳入规划：单双周、多校区、命名教学组、走班/合班、通勤间隔等都要有真实落点。
- 澄清方式优先用对话追问，而不是只把卡片标红。
- 生效范围不止求解：求解、发布校验、当前导出都要能体现。
- 双单周采用“内部一张课表 + weekPattern 元数据”，前端/导出可切换单周、双周或合并视图。
- 多校区采用“通勤间隔”模型：教师/班级/教室有校区，跨校区连续课需要间隔。
- 教学组采用“命名教学组”深度：支持走班、合班、拆班资源占用；第一阶段不做到学生个人级冲突。
- 用新模型开关或模型版本保护旧项目，旧项目不被强制迁移。
- 回归样本优先来自真实 xlsx 和真实自然语言，不只写理想化单元测试。

## 阶段 0：OpenSpec 提案

状态：已完成。OpenSpec 提案已创建并经用户审批，已进入阶段 1 实施。

原因：这是新能力、跨模块重构、数据模型扩展和接口扩展，必须先走 OpenSpec。

建议 change id：

- `add-timetable-natural-language-modeling`

建议拆成这些 capability delta：

- `legacy-timetable-smart-constraints`：自然语言需求语义层和追问能力。
- `legacy-timetable-project-model`：复杂排课模型字段和兼容迁移。
- `legacy-timetable-scheduler`：求解器对复杂资源和 weekPattern 的支持。
- `legacy-timetable-publication-export`：发布校验和导出展示。

OpenSpec 文件应包含：

- `proposal.md`：为什么要做、改什么、影响哪些模块。
- `design.md`：语义层、模型版本、复杂规则、求解和前端数据流。
- `tasks.md`：按 TDD 和阶段推进。
- `specs/*/spec.md`：新增/修改的能力需求。

审批要求：

- 用户已确认 proposal/design/tasks，可以进入阶段 1 实现。
- 如果实施中发现要扩大模型范围或改变既有流程，停下来重新确认。

## 阶段 1：理解和追问层

目标：先让系统能稳定“理解需求”，即使暂时不能全部自动应用。

当前状态：

- 阶段 1 已完成：文本、xlsx、手动填写三个入口都进入同一套对象优先需求语义层和审核台。
- 阶段 2 已完成：已引入复杂项目模型基础字段、模型版本开关、复杂需求落点写入和 legacy 兼容迁移。
- 已完成追问闭环：`高负载教师不要连续太多` 识别为对象优先需求，缺少连续节次阈值时生成 clarification，不再默认猜 3 节直接应用。
- 已新增 `/api/tools/timetable/requirements/clarify`：提交用户回答后更新对应 requirement，并重新生成 ready `semanticActions`。
- 已在智能约束助手右侧详情中展示“需要补充”问题、数字输入和“更新需求”按钮，回答后局部刷新审核结果。
- 已新增 `modelSupport` / complex intent 覆盖：单双周 `weekPattern`、跨校区通勤 `campus_commute_gap`、合班/教学组 `teaching_group_session`、教室/场地需求 `room_requirement` 会被识别为需要 `complex_v1` 的复杂需求；legacy 项目中会提示模型未启用，complex_v1 项目中可生成并应用对应模型动作。
- 已在智能约束助手右侧详情中展示复杂模型未支持提示，避免把复杂需求伪装成已生效规则。
- 已让手动填写入口创建显式 `requirementItems`，并和对应 `draftRows` 机器规则关联；应用成功后左右两侧状态会同步清理。
- 已新增 `timetableModelVersion: "complex_v1"` / `complexModelEnabled`：旧项目默认保持 `legacy`，不会被强制升级。
- 已支持复杂模型数据字段归一化和保存：`weekPattern`、`campuses`、`rooms`、`roomRequirement`、`teachingGroups`、`commuteRules`、教师/班级/任课计划校区字段。
- 已让复杂语义动作可写入项目字段：单双周写入任课计划/课程偏好，场地需求写入任课计划并可创建 room，合班写入教学组，跨校区通勤写入 commute rules。
- 阶段 3 已完成：复杂模型字段已经参与本地快速求解、发布校验、当前导出和 Timefold 降级保护。
- 已修复 legacy 发布快照兼容：旧模型发布指纹不被默认复杂字段污染，发布、导出、恢复仍保持原行为。
- 已保持旧字段兼容：`draftRows`、`requirementItems`、`semanticActions`、`clarifyingQuestions`、`nextAction` 继续可用。
- 已验证：`node --test test/timetable-rule-parser.test.js`、`node --test test/gateway-modules.test.js`、`node --test test/timetable-planner-ui.test.js test/timetable-smart-workbench.test.js`、`node --test test/timetable-project-normalization.test.js`、`node --test test/timetable-scheduler.test.js test/timetable-solver-bridge.test.js`、`npm run test:timetable:rule-review-smoke`、`npm test` 均通过。

后端改造：

- 三入口统一进入同一语义 pipeline：文本、xlsx、手动填写都生成 `requirementItems`。
- 本地确定性解析优先，AI 只补低置信或无法归类内容。
- AI 只输出候选语义，必须再经过本地实体匹配、时间校验、对象校验和动作路由。
- 增加 clarification 状态：缺对象、缺时间、缺阈值、缺单双周、缺校区、缺教学组时生成可回答问题。
- 继续兼容现有字段：`draftRows`、`requirementItems`、`semanticActions`。

前端改造：

- 智能约束助手保留现有入口和弹窗框架，但内部升级为“需求审核 + 追问确认”。
- 已理解需求表格显示对象、需求、条件、落点、状态、置信度、来源。
- 需追问项直接显示问题和可填写答案，答案提交后刷新对应需求和动作。
- 手动填写不再绕过语义层，而是创建结构化 requirement item。
- xlsx 重复上传继续采用替换策略，避免旧结果叠加。

建议新增/扩展接口：

- 保持 `/api/tools/timetable/rule-review/parse` 兼容。
- 保持 `/api/tools/timetable/requirements/apply` 兼容。
- 新增 `POST /api/tools/timetable/requirements/clarify`，用于提交用户回答并重算对应 requirement/action。

阶段 1 验收：

- 系统能把“语文尽量上午第1-3节”“数学必须连堂”“高负载教师不要连续太多”“张老师跨校区不要连续两节”等识别成对象优先需求。
- 缺信息时不猜，能提出具体追问。
- 已支持的内容能生成可应用动作；未支持的内容明确说明需要模型扩展。

## 阶段 2：复杂项目模型

目标：让常见复杂自然语言需求有真实数据落点，而不是只停留在卡片说明。

当前状态：已完成模型基础和兼容迁移；复杂字段可以保存、读取、由语义动作写入，并已在阶段 3 接入本地求解、发布校验和导出。

模型版本：

- 已增加项目模型版本和开关：`timetableModelVersion: "complex_v1"`、`complexModelEnabled`。
- 旧项目默认继续按 `legacy` 模型运行，不强制升级。
- 打开新模型后，复杂字段参与解析、保存、求解、发布校验和导出。

单双周：

- 已统一使用 `weekPattern`：`every`、`odd`、`even`、`odd_even`。
- 新模型下规则、任课计划、发布快照和排课结果 slot 可携带 weekPattern。
- 冲突检测只在 weekPattern 重叠时触发；单周和双周可共享同一格，每周与单/双周重叠会被拦截。
- 当前导出会显示周次标记；后续如需完整前端单周/双周切换视图，可单独扩展。

多校区：

- 新模型下教师、班级、教室、任课计划可关联 campus。
- 已增加通勤规则数据落点：`commuteRules.defaultGapPeriods` 和 `commuteRules.teacherGapPeriods`。
- 默认通勤间隔需要在项目设置或规则里确认，不能硬编码。
- 发布前校验会拦截跨校区通勤间隔不足，并生成可定位的问题条目。

命名教学组：

- 已增加 `teachingGroups[]`：名称、类型、成员班级、课程、教师、教室。
- 新模型下任课计划可指向 `teachingGroupId`。
- 排课 slot 已携带教学组和成员班级占用；教学组课程会占用所有成员班级。
- 第一阶段不做学生个人选课表级冲突；如果自然语言涉及个人学生冲突，标记为后续能力。

教室/场地：

- 现有 `roomId/allowedRoomIds` 继续兼容；新模型下正式补充 `rooms[]` 和 `roomRequirement`。
- 教室可有 campus、容量、标签。
- 容量信息缺失时不自动判断超员，只提示需补充数据。

阶段 2 验收：

- 已通过：旧项目加载和保存不丢字段、不被强制升级。
- 已通过：新模型项目能保存单双周、校区、教学组、教室属性。
- 已通过：自然语言需求能落到这些字段，而不是被判为不支持。

## 阶段 3：求解、发布和导出闭环

目标：让新模型真正影响排课结果和最终交付。

当前状态：已完成。复杂需求不再只停留在“识别出来”，而是会影响本地快速求解、发布校验和当前导出；Timefold bridge 在未声明支持 complex model 时会明确拒绝/降级，避免忽略复杂规则后返回成功。

求解器：

- 任务展开时考虑 weekPattern、教学组、多教师、多班级、教室。
- 同一资源只在 weekPattern 重叠时冲突。
- 单周和双周可以共享同一时间格，但必须在展示中清楚标记。
- 教学组课程占用所有成员班级和关联教师。
- 跨校区通勤间隔作为硬约束或高权重软约束，按用户确认规则执行。
- 修复和局部优化阶段不得破坏 locked/manual protected slot、weekPattern 和教学组资源占用。
- 已实现：任务展开输出 `weekPattern/classIds/teachingGroupId/campusId/roomRequirement`；候选过滤和冲突检测使用周次重叠、教学组成员班级、教室占用和跨校区通勤间隔。

Timefold/可选优化：

- 如果 Timefold 后台暂不支持 complex_v1，要明确禁用或降级，不允许给出看似成功但忽略复杂规则的结果。
- 如果继续支持，需要同步扩展 Timefold domain 和冲突规则。
- 已实现：默认拒绝 complex_v1 调用 Timefold，并返回 `complex_model_not_supported`；只有显式配置支持 complex model 时才允许走 bridge。

发布校验：

- 发布前检查教师冲突、班级冲突、教室冲突、weekPattern 冲突、教学组占用、跨校区通勤。
- 校验问题要能定位到周次类型、星期、节次、对象和规则来源。
- 已实现：发布校验会产生 `week_pattern_conflict`、`teaching_group_conflict`、`campus_commute_conflict` 和 `room-conflict` 等问题类型。

导出展示：

- 当前导出支持合并视图、单周视图、双周视图。
- 格子显示课程、班级/教学组、教师、教室、校区、单双周标记。
- 如果导出格式不支持某些复杂信息，必须在导出前提示。
- 已实现：当前 xlsx 导出会在课表格子中显示周次、校区、教学组/班级、教室/场地标签。

阶段 3 验收：

- 复杂需求不只是“识别出来”，而是真的影响求解结果。
- 发布校验能阻止违反复杂规则的课表。
- 导出的课表能被教务人员看懂，不丢单双周、校区、教学组信息。
- 已通过：Phase 3 定向复杂模型用例、求解器/Timefold 全文件测试、rule-review 冒烟和全量 `npm test`。

## 建议测试样本

自然语言：

- `语文尽量安排在上午第1-3节`
- `语文、数学、英语尽量上午前四节，尤其优先第1-3节`
- `数学必须连堂`
- `未注明的课程默认单节`
- `连堂块不能拆开`
- `高负载教师不要连续太多`
- `张老师跨校区不要连续两节`
- `单周语文第一节优先`
- `双周物理实验排实验楼`
- `初一1班和初一2班合班上音乐`
- `A组走班数学周三前两节不排`

xlsx：

- 结构化约束表连续解析两次结果完全一致。
- 同一 xlsx 在有 AI Key 和无 AI Key 时，高置信本地行结果一致。
- 一行展开多条需求时，所有结果保留同一 `sourceSheet/sourceRow`。
- 低置信行进入追问或复核，不覆盖本地高置信行。

求解：

- 单周和双周同一资源同一时间可共存；每周和单周同一时间不可共存。
- 跨校区连续课在通勤间隔不足时不可排或被发布校验拦截。
- 合班/走班课占用所有成员班级，不能与成员班级其它课冲突。
- locked/manual protected slots 在修复和优化中不被移动。

前端：

- 三入口识别结果都进入同一“已理解需求”审核台。
- 追问回答后，只刷新相关需求，不清空其它已确认项。
- 当前分类应用、暂停/恢复应用、删除、编辑机器规则仍正常。
- 桌面和移动端无横向溢出，底部按钮可见。

验证命令：

- `node --test test/timetable-rule-parser.test.js`
- `node --test test/gateway-modules.test.js`
- `node --test test/timetable-planner-ui.test.js test/timetable-smart-workbench.test.js`
- `node --test test/timetable-scheduler.test.js`
- `npm run test:timetable:rule-review-smoke`
- `npm test`
- Playwright 截图验收智能约束助手、单双周视图、发布校验和导出预览。

## 当前恢复点

如果后续对话中断，从这里继续：

1. 先读取本文件，恢复目标、阶段和边界。
2. 读取 `OpenSpec/changes/add-timetable-natural-language-modeling/tasks.md`，确认阶段 0/1/2/3 已完成。
3. 下一步可以做最终审查、归档 OpenSpec change，或单独设计前端单双周视图、学生个人级冲突、`.fet/.yqd` 写回等后续能力。
4. 如果未来要让 Timefold 支持 complex model，需要同步扩展 Timefold domain 和约束规则后再打开 `TIMEFOLD_TIMETABLE_COMPLEX_MODEL=1`。

## 暂不纳入第一轮的内容

- 学生个人选课表级冲突。
- 外部 `.fet/.yqd` 精确写回。
- 多校区的真实地图距离或交通时间计算。
- 完整替换当前智能约束助手入口。
- 恢复旧 `smart-workbench`。
