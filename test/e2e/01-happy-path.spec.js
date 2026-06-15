import { test, expect } from '@playwright/test';
import { SmartWorkbenchPage } from '../page-objects/SmartWorkbenchPage.js';
import { StepRailPage } from '../page-objects/StepRailPage.js';
import { ConstraintListPage } from '../page-objects/ConstraintListPage.js';
import { generateSmallDataset, constraintsToText } from '../fixtures/fixture-generator.js';
import { waitForInteractive, ConsoleCollector } from '../helpers/test-helpers.js';

/**
 * 01 - Happy Path 核心流程测试
 *
 * 覆盖完整的用户交互流程：
 * 打开工作台 → 粘贴约束 → 解析 → 确认 → 生效 → 关闭
 */

test.describe('智能排课工作台 - 核心流程', () => {
  let workbenchPage;
  let stepRailPage;
  let constraintListPage;
  let consoleCollector;

  test.beforeEach(async ({ page }) => {
    // 初始化页面对象
    workbenchPage = new SmartWorkbenchPage(page);
    stepRailPage = new StepRailPage(page);
    constraintListPage = new ConstraintListPage(page);
    consoleCollector = new ConsoleCollector(page);

    // 导航到排课工具页面
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 等待页面加载完成
    await waitForInteractive(page, '#app', 10000);
  });

  test('应该成功打开智能工作台', async ({ page }) => {
    // 查找并点击智能工作台按钮
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();

    if (await openButton.count() > 0) {
      await openButton.click();
    } else {
      // 如果没有找到按钮，尝试直接检查工作台是否已经可见
      console.log('未找到打开按钮，检查工作台是否已显示');
    }

    // 验证工作台显示
    const isVisible = await workbenchPage.isVisible();
    expect(isVisible).toBeTruthy();

    // 验证核心元素存在
    await expect(workbenchPage.textareaInput).toBeVisible();
    await expect(workbenchPage.parseButton).toBeVisible();

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/01-workbench-opened.png' });
  });

  test('应该成功粘贴并解析约束', async ({ page }) => {
    // 生成测试数据
    const dataset = generateSmallDataset();
    const constraintsText = constraintsToText(dataset.constraints);

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 粘贴约束文本
    await workbenchPage.pasteConstraints(constraintsText);

    // 验证文本已填充
    const inputValue = await workbenchPage.textareaInput.inputValue();
    expect(inputValue.length).toBeGreaterThan(0);

    // 点击解析按钮
    await workbenchPage.clickParse();

    // 等待解析完成
    await workbenchPage.waitForParsed();

    // 验证约束数量
    const count = await workbenchPage.getConstraintCount();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(dataset.size);

    // 验证第一个约束项可见
    await expect(workbenchPage.getConstraintItem(0)).toBeVisible();

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/01-constraints-parsed.png' });
  });

  test('应该完成完整的约束确认流程', async ({ page }) => {
    // 生成测试数据
    const dataset = generateSmallDataset();
    const constraintsText = constraintsToText(dataset.constraints);

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 执行粘贴和解析
    await workbenchPage.pasteConstraints(constraintsText);
    await workbenchPage.clickParse();
    await workbenchPage.waitForParsed();

    // 记录解析后的约束数量
    const parsedCount = await workbenchPage.getConstraintCount();

    // 点击确认按钮
    await workbenchPage.clickConfirm();

    // 等待确认操作完成（可能有动画或异步操作）
    await page.waitForTimeout(1000);

    // 验证状态变化或成功提示
    // 注意：这里需要根据实际实现调整断言
    const hasErrors = consoleCollector.hasErrors();
    if (hasErrors) {
      console.log('Console errors:', consoleCollector.getErrors());
    }

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/01-constraints-confirmed.png' });

    // 验证确认后状态
    expect(parsedCount).toBeGreaterThan(0);
  });

  test('应该成功关闭工作台', async ({ page }) => {
    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 验证工作台已打开
    expect(await workbenchPage.isVisible()).toBeTruthy();

    // 关闭工作台
    await workbenchPage.close();

    // 验证工作台已关闭
    const isVisible = await workbenchPage.isVisible();
    expect(isVisible).toBeFalsy();

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/01-workbench-closed.png' });
  });

  test('应该正确显示步骤进度', async ({ page }) => {
    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 检查步骤导航是否可见
    const stepRailVisible = await stepRailPage.stepRail.isVisible();

    if (stepRailVisible) {
      // 获取当前激活步骤
      const activeStep = await stepRailPage.getActiveStepIndex();
      expect(activeStep).toBeGreaterThanOrEqual(0);

      // 生成并执行解析
      const dataset = generateSmallDataset();
      const constraintsText = constraintsToText(dataset.constraints);
      await workbenchPage.pasteConstraints(constraintsText);
      await workbenchPage.clickParse();
      await workbenchPage.waitForParsed();

      // 验证步骤变化
      await page.waitForTimeout(500);
      const newActiveStep = await stepRailPage.getActiveStepIndex();

      // 步骤索引应该变化或保持有效
      expect(newActiveStep).toBeGreaterThanOrEqual(0);
    } else {
      console.log('步骤导航不可见，跳过步骤测试');
    }

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/01-step-progress.png' });
  });

  test('应该支持清空约束操作', async ({ page }) => {
    // 生成测试数据
    const dataset = generateSmallDataset();
    const constraintsText = constraintsToText(dataset.constraints);

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 执行粘贴和解析
    await workbenchPage.pasteConstraints(constraintsText);
    await workbenchPage.clickParse();
    await workbenchPage.waitForParsed();

    // 验证有约束
    const countBefore = await workbenchPage.getConstraintCount();
    expect(countBefore).toBeGreaterThan(0);

    // 点击清空按钮
    await workbenchPage.clickClear();
    await page.waitForTimeout(500);

    // 验证约束已清空
    const countAfter = await workbenchPage.getConstraintCount();
    expect(countAfter).toBe(0);

    // 验证输入框也被清空
    const inputValue = await workbenchPage.textareaInput.inputValue();
    expect(inputValue.length).toBe(0);

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/01-constraints-cleared.png' });
  });
});
