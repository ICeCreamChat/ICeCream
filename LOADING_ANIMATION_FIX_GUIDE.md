# 排课系统 Loading 动画修复与验证记录

**日期**: 2026-06-13
**修复人**: Codex
**状态**: 已完成代码修复，自动化测试通过。浏览器视觉效果仍建议手工确认一次。

---

## 问题

用户反馈：在排课工具前端点击“智能解析”“解析并继续”等按钮后，没有看到 loading 动画。

期望效果：

1. 按钮立即进入 disabled 状态。
2. 图标从 `sparkles` 切换为 `loader-2`。
3. 图标添加 `tt-spin` 并旋转。
4. 文案显示为“智能解析中”。

---

## 本轮修复

### 1. `parseRules()` 补充初始渲染

**文件**: `public/js/tools/timetable/controller.js`

修复点：

```javascript
this.state.ruleReview = {
    ...review,
    open: true,
    text,
};
this.render();
```

原因：进入文件读取或自然语言解析流程前，先把复核弹窗的打开状态和输入文本同步到 DOM，避免后续 loading 状态更新前 UI 状态滞后。

### 2. 补充回归测试

**文件**: `test/timetable-planner-ui.test.js`

新增测试：

```text
timetable rule review parse renders the opened input state before progress updates
```

该测试确认 `parseRules()` 在设置 `ruleReview.open/text` 后、进入 `try` 解析流程前调用了 `this.render()`。

---

## 当前代码核对

### Controller loading 状态

**文件**: `public/js/tools/timetable/controller.js`

已确认：

1. `setRuleReviewProgress()` 设置 `loading: true`，并在末尾调用 `this.render()`。
2. `parseRules()` 设置 `ruleReview.open/text` 后调用 `this.render()`。
3. `stopRuleReviewProgress()` 设置 `loading: false`，并在末尾调用 `this.render()`。

### View loading 渲染

**文件**: `public/js/tools/timetable/view.js`

已确认 `renderRuleReviewInput()` 会根据 `dialog.loading` 渲染：

```javascript
const isBusy = Boolean(dialog.loading);
const parseIcon = isBusy ? 'loader-2' : 'sparkles';
const actionIconClass = isBusy ? ' class="tt-spin"' : '';
const parseText = isBusy ? '智能解析中' : '智能解析';
```

按钮会在 loading 时带上 `disabled`，并输出 `data-lucide="loader-2"` 与 `class="tt-spin"`。

### CSS 动画

**文件**: `public/css/timetable-planner.css`

已确认存在：

```css
.tt-spin {
    animation: tt-spin 1s linear infinite;
}

@keyframes tt-spin {
    to {
        transform: rotate(360deg);
    }
}
```

### Lucide 图标初始化

**文件**: `public/js/tools/timetable/controller.js`

已确认 `render()` 渲染后调用：

```javascript
window.lucide?.createIcons();
```

这会让 `data-lucide="loader-2"` 在每次重新渲染后重新生成 SVG 图标。

---

## 验证结果

### 目标 UI 测试

```bash
node --test test/timetable-planner-ui.test.js
```

```text
tests 110
pass 110
fail 0
```

### 全量 Node 测试

```bash
npm test
```

```text
tests 580
pass 580
fail 0
```

### Java solver 测试

```bash
npm run solver:test
```

```text
Tests run: 24, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
```

### 当前总计

```text
604/604 自动化测试通过
```

---

## 浏览器手工验收清单

自动化测试已经确认 HTML、CSS 和控制器渲染时机。仍建议手工做一次视觉验收：

1. 启动项目并打开 `http://localhost:3000`。
2. 进入排课工具。
3. 打开“智能约束 / 约束复核中心”。
4. 输入自然语言约束，或选择 TXT/XLSX 约束文件。
5. 点击“智能解析”。
6. 确认按钮立即变灰、图标为旋转的 `loader-2`、文字为“智能解析中”。
7. 如果使用文件解析，确认进度条显示“读取约束文件中...”或“智能解析约束中...”。

---

## 注意事项

1. 本轮没有加入临时 `console.log` 调试代码。
2. 本轮没有创建临时 `test-loading.html`。
3. 如果浏览器中仍看不到动画，优先检查 CSS 是否被缓存，可尝试强制刷新。
4. 如果图标不出现但文字已变化，优先检查 lucide 脚本是否正常加载。
