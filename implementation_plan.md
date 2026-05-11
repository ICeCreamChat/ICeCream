# 反馈真实截图修复计划

## Summary
当前黑板左侧灰白、右侧发黑的根因是 `html2canvas` 不是浏览器真实截图，而是重新绘制 DOM/CSS；黑板使用多层渐变、SVG 噪声、阴影、`overflow: visible` 和负向定位装饰，再经过缩略图压缩后会出现边缘伪影。修复目标改为使用浏览器真实像素截图，截图内容必须和前端实际画面一致。

## Key Changes
- 将反馈截图主路径从 `html2canvas` 改为 `navigator.mediaDevices.getDisplayMedia()`，优先让用户选择当前标签页，截取第一帧后立刻停止 stream。
- 按 `.sp-main` 的 `getBoundingClientRect()` 从真实画面中裁切座位工具主体区域，继续输出 JPEG，最大宽度约 1280px，质量约 `0.72`。
- 打开反馈时先尝试真实截图，再显示反馈弹窗；如果用户拒绝授权或浏览器不支持，则显示“未获取真实截图，可直接提交或使用自动快照”。
- “重新截图”使用真实截图，截图瞬间短暂隐藏反馈弹窗和浮层；失败或取消时保留上一张截图，相机图标不旋转。
- 隐私遮挡不再改真实 DOM，改为真实截图后在 canvas 上按姓名/详情 DOM 区域打码；不为黑板添加截图专用样式。
- 保留 `html2canvas` 作为显式 fallback，按钮文案标明“自动快照（可能不完全一致）”。

## Interfaces
- 后端反馈 API 和截图 payload 保持兼容，仍发送 `screenshot.dataUrl`、`mimeType`、`width`、`height`、`privacyMode`、`capturedAt`、`target`。
- 前端新增/重构 helper：`captureFeedbackScreenScreenshot()`、`drawScreenCaptureFrameToCanvas()`、`getFeedbackScreenshotCropRect()`、`applyFeedbackScreenshotRedactionMasks()`。

## Test Plan
- `node --test test/seating-planner-ui.test.js`
- `node --test test/seating-feedback.test.js`
- `node --test test/seating-planner-ui.test.js test/seating-arrange-route.test.js test/seating-feedback.test.js`

## Assumptions
- 目标浏览器支持 Screen Capture API，优先 Chrome/Edge。
- 用户接受浏览器截图授权提示，并在选择器中选择当前标签页。
- 点“重新截图”时允许反馈弹窗短暂隐藏，避免把弹窗本身截进去。
- 截图范围继续固定为 `.sp-main` 座位工具主体区域。
