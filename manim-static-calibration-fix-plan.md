# 计划：彻底修复 Manim Studio 静态校准应用后视频无变化

## 目标

用户在静态校准画布拖动对象后，点击“应用到整段动画”，必须满足：

- 前端实际发送变化后的 `layoutEditSpec`
- 后端返回的 `code` 和原代码不同
- 代码面板可见新增或更新的补丁
- `/api/manim/render` 使用新代码重新渲染
- 视频 URL 或视频内容实际更新

## 重点假设

之前只修了后端插入 `.shift()` 的位置，但用户仍反馈无变化，所以剩余问题大概率在以下链路之一：

- 前端拖动状态没有进入 `layoutEditSpec`
- `sourceBBox` 和 `normalizedBBox` 实际相同
- 后端生成了新代码，但前端没有用新代码渲染
- render 缓存或 `videoUrl` 更新逻辑导致仍显示旧视频
- 补丁插入代码可见，但 Manim 对象被动画、updater 或后续语句再次覆盖

## 实施步骤

### 1. 加链路日志或调试断言

只在开发环境或临时测试里加，不要长期污染 UI：

- 在 `public/js/core/code-panel.js` 的 `buildLayoutEditSpec()` 打印：
  - `pendingObjectEdits`
  - `objectEdits`
  - 每个 edit 的 `objectId/sourceBBox/normalizedBBox`
- 在 `applyScenePatch()` 打印：
  - layout-rebuild 响应的 `success`
  - `data.code !== code`
  - `patchSummary`
- 在后端 `apply_layout_rebuild()` 临时记录：
  - 输入 edits
  - 生成 patches
  - 每个 patch 后 `next_code != previous_code`

### 2. 修前端发送空变化的问题

检查 `recordCanvasObjectEdit()` 和 `updateSceneObjectBox()`：

- 确认拖动前 `_studioOriginalBBox` 永远保存“拖动前”的 bbox
- 确认拖动后 `normalizedBBox` 来自 `objectBoxOverrides`
- 如果 `sourceBBox` 与 `normalizedBBox` 相同，前端不要发成功申请，直接保留 draft 并提示“没有检测到位移”
- React Studio 路径也要检查：`src/manim-studio/main.jsx` 是否绕过了 `code-panel.js` 的 pending edit 状态

### 3. 修后端补丁策略

保留现有 API，不改字段：

- `replace_text` 继续直接替换赋值字符串
- `move/scale/set_color/delete` 插入到目标对象最后一次布局相关语句之后
- 如果目标对象在 `VGroup/Group` 中，跟踪该 group 变量，延后到 group 的 `move_to/place_visual/fit_to_frame/arrange` 后
- 如果目标对象后续还有 `self.play(obj.animate.move_to(...))` 或 updater，需要插到最后一次会影响目标位置的动画或赋值之后，或者返回 warning 说明无法安全静态补丁

### 4. 修渲染和缓存显示问题

检查 `renderCode()`：

- 应用校准后必须用 `data.code` 渲染，而不是旧 `currentCode`
- render 请求体里的 code 应与编辑器一致
- 成功渲染后 video URL 必须带 cache busting，例如 `?t=Date.now()`
- 如果服务端返回相同 `videoUrl`，前端仍要刷新 `<video>` source 并 reload

### 5. 必加回归测试

后端：

- 拖动对象后，断言返回 code 不同
- `sourceBBox != normalizedBBox` 时必须生成 `.shift`
- `.shift` 出现在 `next_to/move_to/VGroup/place_visual/fit_to_frame` 之后
- `sourceBBox == normalizedBBox` 时失败，不假成功
- 对象后续被 `self.play(obj.animate.move_to(...))` 覆盖时，要么插到其后，要么明确失败

前端 Node 测试：

- 模拟拖动对象后 `buildLayoutEditSpec()` 的 `objectEdits[0].sourceBBox !== normalizedBBox`
- layout-rebuild 成功且无 `videoUrl` 时，`renderCode(data.code)` 被调用
- layout-rebuild 失败时，不清空 pending canvas draft

## 验证命令

```powershell
python -m unittest manim-service.tests.test_agent.ManimAgentV4Tests
```

```powershell
$files = Get-ChildItem manim-service -Recurse -Filter *.py | Where-Object { $_.FullName -notmatch '\\.venv\\|\\.pip-cache\\' } | ForEach-Object { $_.FullName }
python -m py_compile @files
```

```powershell
node --test test/manim-agent.test.js test/manim-suggestions.test.js
```

## 手动验证

1. 启动服务
2. 渲染一个 Manim 视频
3. 打开静态校准画布
4. 拖动一个文字对象明显距离
5. 点击“应用到整段动画”
6. 确认代码面板出现 `.shift(...)`
7. 确认视频重新渲染后对象位置变化

## 验收标准

- 不能只看接口 success，必须确认 `newCode !== oldCode`
- 不能只看代码变了，必须确认 render 请求使用的是 `newCode`
- 不能只看 render 成功，必须确认前端视频源刷新
- 如果无法安全修改目标对象，必须返回失败，不允许假成功
