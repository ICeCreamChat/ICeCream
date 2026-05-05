# 反馈截图功能落地修正计划

## Summary
反馈弹窗增加前端截图能力：打开反馈时自动截取座位工具区域，弹窗中显示截图预览，提交反馈时把截图作为可选附件发送给后端。截图默认开启隐私遮挡，用户可手动关闭。

## Key Changes
- 反馈弹窗新增“前端截图”区域：截图预览、状态文案、重新截图按钮、姓名和详情遮挡开关。
- 截图目标固定为 `.sp-app` 座位工具区域；截图时临时隐藏反馈弹窗、聊天浮窗、菜单和 tooltip。
- 前端复用 `ensureHtml2Canvas()`，输出 JPEG data URL，最大宽度约 1280px，质量约 0.72。
- 提交反馈时等待正在生成的截图完成；截图失败不阻塞文字反馈。
- 后端只接受 PNG/JPEG data URL，并限制 data URL 长度约 1.5MB。
- 合法截图保存到 `seating-feedback-assets/{feedbackId}.jpg|png`，JSONL 只记录 metadata 和相对文件名。
- SMTP 邮件配置存在时，邮件附带截图附件。

## Implementation Changes
- `public/js/tools/seating-planner.js` 增加截图状态、截图捕获、预览渲染、隐私模式读取和 payload 扩展。
- `public/css/seating-planner.css` 增加截图区域样式、截图期间浮层隐藏样式和隐私遮挡样式。
- `gateway/services/seating-feedback.js` 增加截图校验、base64 解码、资产保存和邮件附件接入。
- 不改变现有反馈分类、严重程度、文字字段和座位数据结构。

## Test Plan
- `node --test test/seating-planner-ui.test.js`
- `node --test test/seating-feedback.test.js`
- `node --test test/seating-planner-ui.test.js test/seating-arrange-route.test.js test/seating-feedback.test.js`

## Assumptions
- 截图默认包含在反馈中。
- 隐私遮挡默认开启，用户可以关闭。
- 截图阶段展示的是当前前端画面，不保存真实学生姓名到 JSONL。
