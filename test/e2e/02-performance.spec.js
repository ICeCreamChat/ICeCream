import { test, expect } from '@playwright/test';
import { SmartWorkbenchPage } from '../page-objects/SmartWorkbenchPage.js';
import { ConstraintListPage } from '../page-objects/ConstraintListPage.js';
import {
  generateSmallDataset,
  generateMediumDataset,
  generateLargeDataset,
  constraintsToText
} from '../fixtures/fixture-generator.js';
import {
  measureResponseTime,
  measureFPS,
  measureMemoryUsage,
  assertResponseTime,
  assertFPS,
  capturePerformanceMetrics
} from '../helpers/test-helpers.js';

/**
 * 02 - Performance 性能测试
 *
 * 覆盖性能指标：
 * - 输入响应时间 < 200ms
 * - 100+ 约束下的滚动流畅度 > 30fps
 * - 大数据量渲染性能
 * - 内存使用监控
 */

test.describe('智能排课工作台 - 性能测试', () => {
  let workbenchPage;
  let constraintListPage;

  test.beforeEach(async ({ page }) => {
    workbenchPage = new SmartWorkbenchPage(page);
    constraintListPage = new ConstraintListPage(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('输入响应时间应小于 200ms', async ({ page }) => {
    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 测量输入响应时间
    const responseTime = await measureResponseTime(async () => {
      await workbenchPage.textareaInput.type('测试约束输入');
    });

    console.log(`输入响应时间: ${responseTime}ms`);

    // 断言：响应时间应小于 200ms
    assertResponseTime(responseTime, 200, '约束输入');

    // 截图记录
    await page.screenshot({ path: 'test-results/screenshots/02-input-response.png' });
  });

  test('解析 50 条约束的性能应可接受', async ({ page }) => {
    const dataset = generateMediumDataset();
    const constraintsText = constraintsToText(dataset.constraints);

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 粘贴约束
    await workbenchPage.pasteConstraints(constraintsText);

    // 测量解析时间
    const parseTime = await measureResponseTime(async () => {
      await workbenchPage.clickParse();
      await workbenchPage.waitForParsed();
    });

    console.log(`解析 ${dataset.size} 条约束耗时: ${parseTime}ms`);

    // 断言：解析时间应小于 3 秒
    assertResponseTime(parseTime, 3000, `解析 ${dataset.size} 条约束`);

    // 验证约束数量
    const count = await workbenchPage.getConstraintCount();
    expect(count).toBeGreaterThan(0);

    // 截图记录
    await page.screenshot({ path: 'test-results/screenshots/02-parse-medium.png' });
  });

  test('100+ 约束下滚动流畅度应大于 30fps', async ({ page }) => {
    const dataset = generateLargeDataset();
    const constraintsText = constraintsToText(dataset.constraints);

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 粘贴并解析大量约束
    await workbenchPage.pasteConstraints(constraintsText);
    await workbenchPage.clickParse();
    await workbenchPage.waitForParsed(10000); // 大数据量需要更长时间

    // 等待渲染稳定
    await page.waitForTimeout(1000);

    // 测量滚动时的帧率
    const constraintList = workbenchPage.constraintList;

    // 开始滚动并测量 FPS
    const fps = await page.evaluate(async () => {
      const list = document.querySelector('.constraint-list');
      if (!list) return 0;

      let frameCount = 0;
      const startTime = performance.now();
      const duration = 2000; // 测量 2 秒

      return new Promise((resolve) => {
        function scroll() {
          list.scrollTop += 5; // 平滑滚动

          frameCount++;
          const elapsed = performance.now() - startTime;

          if (elapsed < duration) {
            requestAnimationFrame(scroll);
          } else {
            const fps = (frameCount / elapsed) * 1000;
            resolve(Math.round(fps));
          }
        }

        requestAnimationFrame(scroll);
      });
    });

    console.log(`滚动帧率: ${fps}fps`);

    // 断言：帧率应大于 30fps
    assertFPS(fps, 30, '大数据量滚动');

    // 截图记录
    await page.screenshot({ path: 'test-results/screenshots/02-scroll-performance.png' });
  });

  test('大数据量渲染性能测试', async ({ page }) => {
    const dataset = generateLargeDataset();
    const constraintsText = constraintsToText(dataset.constraints);

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 记录初始内存
    const memoryBefore = await measureMemoryUsage(page);
    console.log('初始内存使用:', memoryBefore);

    // 粘贴约束
    await workbenchPage.pasteConstraints(constraintsText);

    // 测量渲染时间
    const renderTime = await measureResponseTime(async () => {
      await workbenchPage.clickParse();
      await workbenchPage.waitForParsed(15000); // 大数据量需要更长时间
    });

    console.log(`渲染 ${dataset.size} 条约束耗时: ${renderTime}ms`);

    // 记录渲染后内存
    const memoryAfter = await measureMemoryUsage(page);
    console.log('渲染后内存使用:', memoryAfter);

    // 断言：渲染时间应小于 5 秒
    assertResponseTime(renderTime, 5000, `渲染 ${dataset.size} 条约束`);

    // 验证约束数量
    const count = await workbenchPage.getConstraintCount();
    expect(count).toBeGreaterThan(0);
    console.log(`实际渲染约束数量: ${count}`);

    // 内存增长应在合理范围内（小于 100MB）
    if (memoryBefore && memoryAfter) {
      const memoryGrowth = memoryAfter.usedJSHeapSize - memoryBefore.usedJSHeapSize;
      const memoryGrowthMB = (memoryGrowth / 1024 / 1024).toFixed(2);
      console.log(`内存增长: ${memoryGrowthMB}MB`);
      expect(memoryGrowth).toBeLessThan(100 * 1024 * 1024); // 小于 100MB
    }

    // 截图记录
    await page.screenshot({ path: 'test-results/screenshots/02-large-render.png' });
  });

  test('页面加载性能指标', async ({ page }) => {
    // 重新加载页面以测量加载性能
    await page.goto('/', { waitUntil: 'networkidle' });

    // 捕获性能指标
    const metrics = await capturePerformanceMetrics(page);
    console.log('页面性能指标:', metrics);

    // 断言：DOM 加载时间应小于 2 秒
    expect(metrics.domContentLoaded).toBeLessThan(2000);

    // 断言：首次内容绘制应小于 1.5 秒
    expect(metrics.firstContentfulPaint).toBeLessThan(1500);

    // 截图记录
    await page.screenshot({ path: 'test-results/screenshots/02-page-load.png' });
  });

  test('约束列表虚拟滚动性能', async ({ page }) => {
    const dataset = generateLargeDataset();
    const constraintsText = constraintsToText(dataset.constraints);

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    // 粘贴并解析
    await workbenchPage.pasteConstraints(constraintsText);
    await workbenchPage.clickParse();
    await workbenchPage.waitForParsed(15000);

    // 测试快速滚动到底部的性能
    const scrollToBottomTime = await measureResponseTime(async () => {
      await constraintListPage.scrollToBottom();
      await page.waitForTimeout(100); // 等待滚动完成
    });

    console.log(`滚动到底部耗时: ${scrollToBottomTime}ms`);

    // 测试快速滚动到顶部的性能
    const scrollToTopTime = await measureResponseTime(async () => {
      await constraintListPage.scrollToTop();
      await page.waitForTimeout(100);
    });

    console.log(`滚动到顶部耗时: ${scrollToTopTime}ms`);

    // 断言：滚动操作应快速完成
    expect(scrollToBottomTime).toBeLessThan(500);
    expect(scrollToTopTime).toBeLessThan(500);

    // 截图记录
    await page.screenshot({ path: 'test-results/screenshots/02-virtual-scroll.png' });
  });

  test('连续操作性能稳定性测试', async ({ page }) => {
    const dataset = generateSmallDataset();
    const constraintsText = constraintsToText(dataset.constraints);

    // 打开工作台
    const openButton = page.locator('button:has-text("智能工作台"), button:has-text("Smart Workbench"), [data-tool="timetable-workbench"]').first();
    if (await openButton.count() > 0) {
      await openButton.click();
      await page.waitForTimeout(500);
    }

    const responseTimes = [];

    // 执行 5 次粘贴-解析-清空循环
    for (let i = 0; i < 5; i++) {
      const cycleTime = await measureResponseTime(async () => {
        await workbenchPage.pasteConstraints(constraintsText);
        await workbenchPage.clickParse();
        await workbenchPage.waitForParsed();
        await workbenchPage.clickClear();
        await page.waitForTimeout(200);
      });

      responseTimes.push(cycleTime);
      console.log(`第 ${i + 1} 次循环耗时: ${cycleTime}ms`);
    }

    // 计算平均时间
    const avgTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
    console.log(`平均循环时间: ${avgTime}ms`);

    // 断言：平均时间应小于 3 秒
    expect(avgTime).toBeLessThan(3000);

    // 断言：时间波动不应太大（最大值不超过平均值的 1.5 倍）
    const maxTime = Math.max(...responseTimes);
    expect(maxTime).toBeLessThan(avgTime * 1.5);

    // 截图记录
    await page.screenshot({ path: 'test-results/screenshots/02-stability.png' });
  });
});
