import { test, expect } from '@playwright/test';

test('segment config changes should update period time table in real-time', async ({ page }) => {
  // 启动应用
  await page.goto('http://localhost:3000');

  // 等待页面加载
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // 等待并点击智能排课卡片
  const timetableCard = page.locator('[data-tool="timetable"]');
  await expect(timetableCard).toBeVisible({ timeout: 10000 });
  await timetableCard.scrollIntoViewIfNeeded();
  await timetableCard.click();
  await page.waitForTimeout(2000);

  // 打开节次时间配置对话框
  const periodTimeButton = page.locator('#tt-open-period-time-dialog');
  await expect(periodTimeButton).toBeVisible({ timeout: 10000 });
  await periodTimeButton.click();
  await page.waitForTimeout(1000);

  // 等待对话框出现
  await expect(page.locator('#tt-period-time-dialog')).toBeVisible();

  // 读取初始的第一节课开始时间
  const firstPeriodStart = page.locator('[data-period-time-row="1"]').locator('[data-period-time-draft-start="1"]').first();
  await expect(firstPeriodStart).toBeVisible();
  const initialValue = await firstPeriodStart.inputValue();
  console.log('初始第1节开始时间:', initialValue);

  // 修改第一个时段的"首节开始"时间
  const segmentStartTime = page.locator('[data-segment-field$="-startTime"]').first();
  await expect(segmentStartTime).toBeVisible();
  await segmentStartTime.click();
  await segmentStartTime.fill('08:30');

  // 触发 change 事件
  await segmentStartTime.dispatchEvent('input');
  await segmentStartTime.dispatchEvent('change');

  // 等待一小段时间让事件触发
  await page.waitForTimeout(500);

  // 检查下方时间轴表格是否更新
  const updatedValue = await firstPeriodStart.inputValue();
  console.log('修改后第1节开始时间:', updatedValue);

  // 截图保存证据（不管成功失败都截图）
  await page.screenshot({ path: 'test-results/segment-update-test.png', fullPage: true });

  // 断言：时间应该已经更新
  if (updatedValue === initialValue) {
    console.log('❌ 测试失败：时段配置修改后，时间轴表格没有更新');
    console.log('   预期:', '08:30');
    console.log('   实际:', updatedValue);
  } else {
    console.log('✅ 测试通过：时段配置修改后，时间轴表格已实时更新');
  }

  expect(updatedValue).toBe('08:30');
});
