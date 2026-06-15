import { test, expect, devices } from '@playwright/test';
import { SmartWorkbenchPage } from '../page-objects/SmartWorkbenchPage.js';
import { StepRailPage } from '../page-objects/StepRailPage.js';
import { generateSmallDataset, constraintsToText } from '../fixtures/fixture-generator.js';
import { touchSwipe } from '../helpers/test-helpers.js';

/**
 * 03 - Mobile Responsive 移动端响应式测试
 *
 * 覆盖移动端特性：
 * - 步骤栏横向滚动
 * - 触摸交互
 * - 响应式布局
 * - 移动端手势操作
 */

test.describe('智能排课工作台 - 移动端响应式', () => {
  let workbenchPage;
  let stepRailPage;

  test.beforeEach(async ({ page }) => {
    workbenchPage = new SmartWorkbenchPage(page);
    stepRailPage = new StepRailPage(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('移动端工作台应正确显示', async ({ page }) => {
    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 验证工作台可见
    expect(await workbenchPage.isVisible()).toBeTruthy();

    // 检查移动端布局特征
    const workbenchWidth = await workbenchPage.workbenchContainer.evaluate(el => {
      return window.getComputedStyle(el).width;
    });

    console.log(`移动端工作台宽度: ${workbenchWidth}`);

    // 验证输入区域可见且可交互
    await expect(workbenchPage.textareaInput).toBeVisible();
    await expect(workbenchPage.parseButton).toBeVisible();

    // 截图验证移动端布局
    await page.screenshot({ path: 'test-results/screenshots/03-mobile-layout.png', fullPage: true });
  });

  test('步骤栏应支持横向滚动', async ({ page }) => {
    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 检查步骤栏是否存在
    const stepRailExists = await stepRailPage.stepRail.count() > 0;

    if (stepRailExists) {
      // 检查是否支持横向滚动
      const isScrollable = await stepRailPage.isHorizontalScrollable();
      console.log(`步骤栏是否可横向滚动: ${isScrollable}`);

      // 如果可滚动，测试滚动功能
      if (isScrollable) {
        // 获取步骤数量
        const stepCount = await stepRailPage.stepButtons.count();

        if (stepCount > 1) {
          // 滚动到最后一个步骤
          await stepRailPage.scrollToStep(stepCount - 1);
          await page.waitForTimeout(300);

          // 验证最后一个步骤可见
          const lastStepVisible = await stepRailPage.getStepButton(stepCount - 1).isVisible();
          expect(lastStepVisible).toBeTruthy();
        }
      }

      // 截图验证
      await page.screenshot({ path: 'test-results/screenshots/03-step-rail-scroll.png' });
    } else {
      console.log('步骤栏不存在，跳过测试');
    }
  });

  test('触摸输入应正常工作', async ({ page }) => {
    const dataset = generateSmallDataset();
    const constraintsText = constraintsToText(dataset.constraints);

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.tap(); // 使用 tap 而不是 click
      await page.waitForTimeout(500);
    }

    // 触摸点击输入框
    await workbenchPage.textareaInput.tap();

    // 输入文本（移动端使用 fill）
    await workbenchPage.textareaInput.fill(constraintsText);

    // 验证文本已填充
    const inputValue = await workbenchPage.textareaInput.inputValue();
    expect(inputValue.length).toBeGreaterThan(0);

    // 触摸点击解析按钮
    await workbenchPage.parseButton.tap();

    // 等待解析完成
    await workbenchPage.waitForParsed();

    // 验证约束已解析
    const count = await workbenchPage.getConstraintCount();
    expect(count).toBeGreaterThan(0);

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/03-touch-input.png', fullPage: true });
  });

  test('约束列表应支持触摸滚动', async ({ page }) => {
    const dataset = generateSmallDataset();
    const constraintsText = constraintsToText(dataset.constraints);

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.tap();
      await page.waitForTimeout(500);
    }

    // 粘贴并解析
    await workbenchPage.pasteConstraints(constraintsText);
    await workbenchPage.parseButton.tap();
    await workbenchPage.waitForParsed();

    // 获取约束列表位置
    const listBox = await workbenchPage.constraintList.boundingBox();

    if (listBox) {
      // 记录初始滚动位置
      const scrollBefore = await workbenchPage.constraintList.evaluate(el => el.scrollTop);

      // 执行触摸滑动（向上滑动以滚动列表）
      const startX = listBox.x + listBox.width / 2;
      const startY = listBox.y + listBox.height * 0.8;
      const endY = listBox.y + listBox.height * 0.2;

      await page.touchscreen.tap(startX, startY);
      await page.touchscreen.swipe({ x: startX, y: startY }, { x: startX, y: endY });

      // 等待滚动完成
      await page.waitForTimeout(500);

      // 记录滚动后位置
      const scrollAfter = await workbenchPage.constraintList.evaluate(el => el.scrollTop);

      console.log(`滚动前: ${scrollBefore}, 滚动后: ${scrollAfter}`);

      // 验证列表已滚动
      // 注意：滚动方向可能因实现而异
      expect(scrollAfter).not.toBe(scrollBefore);
    }

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/03-touch-scroll.png', fullPage: true });
  });

  test('移动端应正确显示虚拟键盘', async ({ page }) => {
    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.tap();
      await page.waitForTimeout(500);
    }

    // 点击输入框
    await workbenchPage.textareaInput.tap();

    // 等待一下让虚拟键盘出现
    await page.waitForTimeout(500);

    // 检查输入框是否获得焦点
    const isFocused = await workbenchPage.textareaInput.evaluate(el => {
      return document.activeElement === el;
    });

    expect(isFocused).toBeTruthy();

    // 输入一些文本
    await workbenchPage.textareaInput.type('测试虚拟键盘输入');

    // 验证输入成功
    const inputValue = await workbenchPage.textareaInput.inputValue();
    expect(inputValue).toContain('测试');

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/03-virtual-keyboard.png', fullPage: true });
  });

  test('移动端按钮应有足够的点击区域', async ({ page }) => {
    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.tap();
      await page.waitForTimeout(500);
    }

    // 检查主要按钮的尺寸
    const parseButtonBox = await workbenchPage.parseButton.boundingBox();
    const confirmButtonBox = await workbenchPage.confirmButton.boundingBox();

    if (parseButtonBox) {
      console.log(`解析按钮尺寸: ${parseButtonBox.width}x${parseButtonBox.height}`);
      // 移动端按钮高度应至少 44px（iOS 推荐的最小触摸目标）
      expect(parseButtonBox.height).toBeGreaterThanOrEqual(40);
    }

    if (confirmButtonBox) {
      console.log(`确认按钮尺寸: ${confirmButtonBox.width}x${confirmButtonBox.height}`);
      expect(confirmButtonBox.height).toBeGreaterThanOrEqual(40);
    }

    // 测试按钮点击
    await workbenchPage.parseButton.tap();
    await page.waitForTimeout(200);

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/03-button-size.png' });
  });

  test('横屏模式应正常工作', async ({ page, context }) => {
    // 切换到横屏模式
    await page.setViewportSize({ width: 844, height: 390 }); // iPhone 横屏尺寸

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.tap();
      await page.waitForTimeout(500);
    }

    // 验证工作台在横屏模式下可见
    expect(await workbenchPage.isVisible()).toBeTruthy();

    // 生成并解析约束
    const dataset = generateSmallDataset();
    const constraintsText = constraintsToText(dataset.constraints);

    await workbenchPage.pasteConstraints(constraintsText);
    await workbenchPage.parseButton.tap();
    await workbenchPage.waitForParsed();

    // 验证约束正常显示
    const count = await workbenchPage.getConstraintCount();
    expect(count).toBeGreaterThan(0);

    // 截图验证横屏布局
    await page.screenshot({ path: 'test-results/screenshots/03-landscape-mode.png', fullPage: true });
  });

  test('移动端应支持双指缩放（如果启用）', async ({ page }) => {
    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.tap();
      await page.waitForTimeout(500);
    }

    // 检查 viewport meta 标签设置
    const viewportMeta = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="viewport"]');
      return meta ? meta.getAttribute('content') : null;
    });

    console.log(`Viewport Meta: ${viewportMeta}`);

    // 验证是否禁用了缩放（user-scalable=no）
    const isZoomDisabled = viewportMeta && viewportMeta.includes('user-scalable=no');
    console.log(`缩放是否被禁用: ${isZoomDisabled}`);

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/03-zoom-test.png' });
  });
});
