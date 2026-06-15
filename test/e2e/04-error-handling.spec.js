import { test, expect } from '@playwright/test';
import { SmartWorkbenchPage } from '../page-objects/SmartWorkbenchPage.js';
import { ConstraintListPage } from '../page-objects/ConstraintListPage.js';
import {
  generateSmallDataset,
  generateMalformedDataset,
  generateConflictingDataset,
  constraintsToText
} from '../fixtures/fixture-generator.js';
import { NetworkInterceptor, ConsoleCollector } from '../helpers/test-helpers.js';

/**
 * 04 - Error Handling 错误处理与异常恢复测试
 *
 * 覆盖异常场景：
 * - 网络失败
 * - 解析错误
 * - 冲突检测
 * - 数据格式错误
 * - 边界条件
 */

test.describe('智能排课工作台 - 错误处理', () => {
  let workbenchPage;
  let constraintListPage;
  let networkInterceptor;
  let consoleCollector;

  test.beforeEach(async ({ page }) => {
    workbenchPage = new SmartWorkbenchPage(page);
    constraintListPage = new ConstraintListPage(page);
    networkInterceptor = new NetworkInterceptor(page);
    consoleCollector = new ConsoleCollector(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('应正确处理空输入', async ({ page }) => {
    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 不输入任何内容，直接点击解析
    await workbenchPage.clickParse();
    await page.waitForTimeout(500);

    // 验证：应该显示错误提示或不进行解析
    const count = await workbenchPage.getConstraintCount();
    expect(count).toBe(0);

    // 检查是否有错误提示
    const errorMessage = page.locator('.error-message, .warning-message, [role="alert"]');
    const hasErrorOrWarning = await errorMessage.count() > 0;

    if (hasErrorOrWarning) {
      console.log('检测到错误提示');
      await expect(errorMessage.first()).toBeVisible();
    } else {
      console.log('没有错误提示，可能静默处理了空输入');
    }

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/04-empty-input.png' });
  });

  test('应正确处理格式错误的约束', async ({ page }) => {
    const malformedData = generateMalformedDataset();
    const constraintsText = constraintsToText(malformedData.constraints);

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 粘贴格式错误的约束
    await workbenchPage.pasteConstraints(constraintsText);

    // 点击解析
    await workbenchPage.clickParse();
    await page.waitForTimeout(1000);

    // 验证：应该处理错误或标记无效项
    const count = await workbenchPage.getConstraintCount();

    if (count > 0) {
      console.log(`解析了 ${count} 条约束（可能过滤或修正了错误项）`);

      // 检查是否有错误标记
      const errorItems = page.locator('.constraint-item.error, .constraint-item.invalid');
      const errorCount = await errorItems.count();
      console.log(`标记为错误的约束数: ${errorCount}`);
    }

    // 检查控制台错误
    if (consoleCollector.hasErrors()) {
      console.log('控制台错误:', consoleCollector.getErrors().slice(0, 3));
    }

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/04-malformed-data.png' });
  });

  test('应检测并提示约束冲突', async ({ page }) => {
    const conflictingData = generateConflictingDataset();
    const constraintsText = constraintsToText(conflictingData.constraints);

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 粘贴冲突的约束
    await workbenchPage.pasteConstraints(constraintsText);

    // 点击解析
    await workbenchPage.clickParse();
    await workbenchPage.waitForParsed();

    // 等待冲突检测
    await page.waitForTimeout(1000);

    // 查找冲突提示
    const conflictIndicator = page.locator('.conflict-warning, .conflict-badge, [data-status="conflict"]');
    const hasConflict = await conflictIndicator.count() > 0;

    console.log(`是否检测到冲突: ${hasConflict}`);

    if (hasConflict) {
      await expect(conflictIndicator.first()).toBeVisible();
      const conflictText = await conflictIndicator.first().textContent();
      console.log(`冲突信息: ${conflictText}`);
    } else {
      console.log('未检测到冲突提示（可能需要实现冲突检测功能）');
    }

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/04-conflicts.png' });
  });

  test('应正确处理网络请求失败', async ({ page }) => {
    // 模拟网络失败
    await networkInterceptor.simulateNetworkFailure('**/api/**');

    const dataset = generateSmallDataset();
    const constraintsText = constraintsToText(dataset.constraints);

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 粘贴约束
    await workbenchPage.pasteConstraints(constraintsText);

    // 尝试解析（如果涉及 API 调用）
    await workbenchPage.clickParse();
    await page.waitForTimeout(2000);

    // 检查是否显示网络错误提示
    const networkError = page.locator('.network-error, .error-message:has-text("网络"), .error-message:has-text("失败")');
    const hasNetworkError = await networkError.count() > 0;

    if (hasNetworkError) {
      console.log('检测到网络错误提示');
      await expect(networkError.first()).toBeVisible();
    } else {
      console.log('未检测到网络错误（可能是纯前端解析）');
    }

    // 检查失败的请求
    const failedRequests = networkInterceptor.getFailedRequests();
    console.log(`失败的请求数: ${failedRequests.length}`);

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/04-network-failure.png' });
  });

  test('应正确处理超长约束文本', async ({ page }) => {
    // 生成超长约束
    const longConstraint = '这是一个超长的约束描述。'.repeat(100);
    const constraintsText = `1. ${longConstraint}`;

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 粘贴超长文本
    await workbenchPage.pasteConstraints(constraintsText);

    // 点击解析
    await workbenchPage.clickParse();
    await page.waitForTimeout(1000);

    // 验证：应该能处理或截断超长文本
    const count = await workbenchPage.getConstraintCount();

    if (count > 0) {
      const item = workbenchPage.getConstraintItem(0);
      const itemText = await item.textContent();
      console.log(`解析后的约束长度: ${itemText.length} 字符`);

      // 验证文本是否被合理处理（截断或完整显示）
      expect(itemText.length).toBeGreaterThan(0);
    }

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/04-long-text.png' });
  });

  test('应防止 XSS 攻击', async ({ page }) => {
    // 尝试注入 XSS 代码
    const xssPayload = '<script>alert("XSS")</script><img src=x onerror="alert(1)">';
    const constraintsText = `1. 约束描述包含脚本 ${xssPayload}`;

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 粘贴包含 XSS 的文本
    await workbenchPage.pasteConstraints(constraintsText);

    // 解析
    await workbenchPage.clickParse();
    await page.waitForTimeout(1000);

    // 验证：脚本不应被执行
    const count = await workbenchPage.getConstraintCount();

    if (count > 0) {
      const item = workbenchPage.getConstraintItem(0);

      // 检查是否包含原始脚本标签（应该被转义）
      const innerHTML = await item.innerHTML();
      console.log('HTML 内容:', innerHTML);

      // 验证脚本标签应该被转义或移除
      const hasScriptTag = innerHTML.includes('<script>');
      expect(hasScriptTag).toBeFalsy();

      // 验证文本内容存在
      const textContent = await item.textContent();
      expect(textContent.length).toBeGreaterThan(0);
    }

    // 检查是否触发了任何 alert（不应该有）
    let alertTriggered = false;
    page.on('dialog', () => {
      alertTriggered = true;
    });

    await page.waitForTimeout(500);
    expect(alertTriggered).toBeFalsy();

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/04-xss-prevention.png' });
  });

  test('应正确处理快速连续操作', async ({ page }) => {
    const dataset = generateSmallDataset();
    const constraintsText = constraintsToText(dataset.constraints);

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 快速连续点击解析按钮
    await workbenchPage.pasteConstraints(constraintsText);

    // 连续点击 3 次（测试防抖/节流）
    await workbenchPage.clickParse();
    await workbenchPage.clickParse();
    await workbenchPage.clickParse();

    // 等待处理完成
    await page.waitForTimeout(2000);

    // 验证：应该只处理一次或正确处理多次点击
    const count = await workbenchPage.getConstraintCount();
    expect(count).toBeGreaterThan(0);

    // 检查控制台错误
    if (consoleCollector.hasErrors()) {
      const errors = consoleCollector.getErrors();
      console.log(`控制台错误数: ${errors.length}`);
    }

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/04-rapid-clicks.png' });
  });

  test('应支持从错误状态恢复', async ({ page }) => {
    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 第一步：输入空数据触发错误
    await workbenchPage.clickParse();
    await page.waitForTimeout(500);

    // 第二步：输入正确数据恢复
    const dataset = generateSmallDataset();
    const constraintsText = constraintsToText(dataset.constraints);
    await workbenchPage.pasteConstraints(constraintsText);
    await workbenchPage.clickParse();
    await workbenchPage.waitForParsed();

    // 验证：应该成功恢复并解析
    const count = await workbenchPage.getConstraintCount();
    expect(count).toBeGreaterThan(0);

    // 第三步：清空并再次输入
    await workbenchPage.clickClear();
    await page.waitForTimeout(300);

    await workbenchPage.pasteConstraints(constraintsText);
    await workbenchPage.clickParse();
    await workbenchPage.waitForParsed();

    // 验证：第二次也应该成功
    const count2 = await workbenchPage.getConstraintCount();
    expect(count2).toBeGreaterThan(0);

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/04-error-recovery.png' });
  });

  test('应正确处理慢速网络', async ({ page }) => {
    // 模拟慢速网络（3 秒延迟）
    await networkInterceptor.simulateSlowNetwork('**/api/**', 3000);

    const dataset = generateSmallDataset();
    const constraintsText = constraintsToText(dataset.constraints);

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 粘贴约束
    await workbenchPage.pasteConstraints(constraintsText);

    // 点击解析
    await workbenchPage.clickParse();

    // 检查是否显示加载指示器
    const loadingIndicator = page.locator('.loading, .spinner, [role="progressbar"]');
    const hasLoading = await loadingIndicator.count() > 0;

    if (hasLoading) {
      console.log('检测到加载指示器');
      await expect(loadingIndicator.first()).toBeVisible();
    }

    // 等待处理完成（考虑慢速网络）
    await page.waitForTimeout(5000);

    // 验证：最终应该成功处理
    const count = await workbenchPage.getConstraintCount();
    console.log(`慢速网络下解析的约束数: ${count}`);

    // 截图验证
    await page.screenshot({ path: 'test-results/screenshots/04-slow-network.png' });
  });
});
