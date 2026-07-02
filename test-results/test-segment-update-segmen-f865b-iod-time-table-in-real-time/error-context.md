# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: test-segment-update.spec.js >> segment config changes should update period time table in real-time
- Location: test-segment-update.spec.js:3:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator:  locator('[data-tool="timetable"]')
Expected: visible
Received: hidden
Timeout:  10000ms

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for locator('[data-tool="timetable"]')
    23 × locator resolved to <div class="app-card" data-tool="timetable">…</div>
       - unexpected value "hidden"

```

```yaml
- complementary:
  - text: ICeCream
  - button "新建对话"
  - text: ICeCream v1.0
- main:
  - text: ICeCream Online
  - button "问答"
  - button "动画"
  - button "解题"
  - button "课堂工具箱"
  - button "切换主题"
  - heading "欢迎使用 ICeCream" [level=1]
  - paragraph: 统一智能平台 - 问答 · 动画 · 解题
  - heading "智能问答" [level=3]
  - paragraph: 自由提问，自动识别聊天、动画或解题任务
  - heading "数学动画" [level=3]
  - paragraph: 自然语言描述，生成 Manim 动画或 GeoGebra 动态几何
  - heading "智能解题" [level=3]
  - paragraph: 上传题目图片，AI 自动解答
  - button "上传图片"
  - textbox "输入框":
    - /placeholder: 输入消息，或上传图片...
  - button "发送消息"
  - button "更多选项"
- text: 题目看板
- button "锁定/解锁看板内容"
- button "收起/展开"
- img "题目图片"
- alert
- alert
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | test('segment config changes should update period time table in real-time', async ({ page }) => {
  4  |   // 启动应用
  5  |   await page.goto('http://localhost:3000');
  6  | 
  7  |   // 等待页面加载
  8  |   await page.waitForLoadState('networkidle');
  9  |   await page.waitForTimeout(2000);
  10 | 
  11 |   // 等待并点击智能排课卡片
  12 |   const timetableCard = page.locator('[data-tool="timetable"]');
> 13 |   await expect(timetableCard).toBeVisible({ timeout: 10000 });
     |                               ^ Error: expect(locator).toBeVisible() failed
  14 |   await timetableCard.scrollIntoViewIfNeeded();
  15 |   await timetableCard.click();
  16 |   await page.waitForTimeout(2000);
  17 | 
  18 |   // 打开节次时间配置对话框
  19 |   const periodTimeButton = page.locator('#tt-open-period-time-dialog');
  20 |   await expect(periodTimeButton).toBeVisible({ timeout: 10000 });
  21 |   await periodTimeButton.click();
  22 |   await page.waitForTimeout(1000);
  23 | 
  24 |   // 等待对话框出现
  25 |   await expect(page.locator('#tt-period-time-dialog')).toBeVisible();
  26 | 
  27 |   // 读取初始的第一节课开始时间
  28 |   const firstPeriodStart = page.locator('[data-period-time-row="1"]').locator('[data-period-time-draft-start="1"]').first();
  29 |   await expect(firstPeriodStart).toBeVisible();
  30 |   const initialValue = await firstPeriodStart.inputValue();
  31 |   console.log('初始第1节开始时间:', initialValue);
  32 | 
  33 |   // 修改第一个时段的"首节开始"时间
  34 |   const segmentStartTime = page.locator('[data-segment-field$="-startTime"]').first();
  35 |   await expect(segmentStartTime).toBeVisible();
  36 |   await segmentStartTime.click();
  37 |   await segmentStartTime.fill('08:30');
  38 | 
  39 |   // 触发 change 事件
  40 |   await segmentStartTime.dispatchEvent('input');
  41 |   await segmentStartTime.dispatchEvent('change');
  42 | 
  43 |   // 等待一小段时间让事件触发
  44 |   await page.waitForTimeout(500);
  45 | 
  46 |   // 检查下方时间轴表格是否更新
  47 |   const updatedValue = await firstPeriodStart.inputValue();
  48 |   console.log('修改后第1节开始时间:', updatedValue);
  49 | 
  50 |   // 截图保存证据（不管成功失败都截图）
  51 |   await page.screenshot({ path: 'test-results/segment-update-test.png', fullPage: true });
  52 | 
  53 |   // 断言：时间应该已经更新
  54 |   if (updatedValue === initialValue) {
  55 |     console.log('❌ 测试失败：时段配置修改后，时间轴表格没有更新');
  56 |     console.log('   预期:', '08:30');
  57 |     console.log('   实际:', updatedValue);
  58 |   } else {
  59 |     console.log('✅ 测试通过：时段配置修改后，时间轴表格已实时更新');
  60 |   }
  61 | 
  62 |   expect(updatedValue).toBe('08:30');
  63 | });
  64 | 
```