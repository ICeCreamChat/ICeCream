/**
 * 测试辅助工具集
 *
 * 提供通用的断言、等待策略、截图对比、性能测量工具
 */

/**
 * 等待元素可见并可交互
 */
export async function waitForInteractive(page, selector, timeout = 5000) {
  const element = page.locator(selector);
  await element.waitFor({ state: 'visible', timeout });
  await element.waitFor({ state: 'attached', timeout });
  return element;
}

/**
 * 等待动画完成
 */
export async function waitForAnimationEnd(page, selector, timeout = 2000) {
  await page.waitForFunction(
    (sel) => {
      const element = document.querySelector(sel);
      if (!element) return false;
      const animations = element.getAnimations();
      return animations.length === 0 || animations.every(a => a.playState === 'finished');
    },
    selector,
    { timeout }
  );
}

/**
 * 等待网络空闲
 */
export async function waitForNetworkIdle(page, timeout = 3000) {
  await page.waitForLoadState('networkidle', { timeout });
}

/**
 * 测量操作响应时间
 */
export async function measureResponseTime(operation) {
  const startTime = Date.now();
  await operation();
  const endTime = Date.now();
  return endTime - startTime;
}

/**
 * 测量渲染帧率（FPS）
 */
export async function measureFPS(page, durationMs = 2000) {
  const fps = await page.evaluate((duration) => {
    return new Promise((resolve) => {
      let frameCount = 0;
      const startTime = performance.now();

      function countFrame() {
        frameCount++;
        const elapsed = performance.now() - startTime;
        if (elapsed < duration) {
          requestAnimationFrame(countFrame);
        } else {
          resolve((frameCount / elapsed) * 1000);
        }
      }

      requestAnimationFrame(countFrame);
    });
  }, durationMs);

  return Math.round(fps);
}

/**
 * 获取元素的计算样式
 */
export async function getComputedStyle(page, selector, property) {
  return await page.locator(selector).evaluate((el, prop) => {
    return window.getComputedStyle(el).getPropertyValue(prop);
  }, property);
}

/**
 * 检查元素是否在视口内
 */
export async function isInViewport(page, selector) {
  return await page.locator(selector).evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
  });
}

/**
 * 滚动到元素位置
 */
export async function scrollToElement(page, selector) {
  await page.locator(selector).evaluate((el) => {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  await page.waitForTimeout(300); // 等待滚动动画
}

/**
 * 模拟触摸滑动（移动端）
 */
export async function touchSwipe(page, selector, direction = 'left', distance = 300) {
  const element = page.locator(selector);
  const box = await element.boundingBox();

  if (!box) {
    throw new Error(`Element ${selector} not found or not visible`);
  }

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  let endX = startX;
  let endY = startY;

  switch (direction) {
    case 'left':
      endX = startX - distance;
      break;
    case 'right':
      endX = startX + distance;
      break;
    case 'up':
      endY = startY - distance;
      break;
    case 'down':
      endY = startY + distance;
      break;
  }

  await page.touchscreen.tap(startX, startY);
  await page.touchscreen.swipe({ x: startX, y: startY }, { x: endX, y: endY });
}

/**
 * 测量内存使用情况
 */
export async function measureMemoryUsage(page) {
  return await page.evaluate(() => {
    if (performance.memory) {
      return {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        usedPercentage: (performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit * 100).toFixed(2)
      };
    }
    return null;
  });
}

/**
 * 断言：响应时间应小于阈值
 */
export function assertResponseTime(actualMs, thresholdMs, operationName) {
  if (actualMs > thresholdMs) {
    throw new Error(
      `${operationName} 响应时间过长: ${actualMs}ms (阈值: ${thresholdMs}ms)`
    );
  }
}

/**
 * 断言：帧率应大于阈值
 */
export function assertFPS(actualFPS, thresholdFPS, operationName) {
  if (actualFPS < thresholdFPS) {
    throw new Error(
      `${operationName} 帧率过低: ${actualFPS}fps (阈值: ${thresholdFPS}fps)`
    );
  }
}

/**
 * 断言：元素应可见
 */
export async function assertVisible(page, selector, errorMessage) {
  const isVisible = await page.locator(selector).isVisible();
  if (!isVisible) {
    throw new Error(errorMessage || `元素 ${selector} 应该可见但实际不可见`);
  }
}

/**
 * 断言：元素应隐藏
 */
export async function assertHidden(page, selector, errorMessage) {
  const isVisible = await page.locator(selector).isVisible();
  if (isVisible) {
    throw new Error(errorMessage || `元素 ${selector} 应该隐藏但实际可见`);
  }
}

/**
 * 断言：文本内容应匹配
 */
export async function assertTextContains(page, selector, expectedText) {
  const actualText = await page.locator(selector).textContent();
  if (!actualText.includes(expectedText)) {
    throw new Error(
      `元素 ${selector} 文本不匹配\n期望包含: ${expectedText}\n实际内容: ${actualText}`
    );
  }
}

/**
 * 捕获性能指标
 */
export async function capturePerformanceMetrics(page) {
  return await page.evaluate(() => {
    const perfData = performance.getEntriesByType('navigation')[0];
    const paintData = performance.getEntriesByType('paint');

    return {
      // 导航时间
      domContentLoaded: perfData.domContentLoadedEventEnd - perfData.domContentLoadedEventStart,
      loadComplete: perfData.loadEventEnd - perfData.loadEventStart,

      // 渲染时间
      firstPaint: paintData.find(e => e.name === 'first-paint')?.startTime || 0,
      firstContentfulPaint: paintData.find(e => e.name === 'first-contentful-paint')?.startTime || 0,

      // 资源时间
      domInteractive: perfData.domInteractive,
      domComplete: perfData.domComplete
    };
  });
}

/**
 * 控制台日志收集器
 */
export class ConsoleCollector {
  constructor(page) {
    this.logs = [];
    this.errors = [];

    page.on('console', msg => {
      const log = {
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now()
      };

      this.logs.push(log);

      if (msg.type() === 'error' || msg.type() === 'warning') {
        this.errors.push(log);
      }
    });
  }

  hasErrors() {
    return this.errors.length > 0;
  }

  getErrors() {
    return this.errors;
  }

  getAllLogs() {
    return this.logs;
  }

  clear() {
    this.logs = [];
    this.errors = [];
  }
}

/**
 * 网络请求拦截器
 */
export class NetworkInterceptor {
  constructor(page) {
    this.page = page;
    this.requests = [];
    this.responses = [];

    page.on('request', request => {
      this.requests.push({
        url: request.url(),
        method: request.method(),
        timestamp: Date.now()
      });
    });

    page.on('response', response => {
      this.responses.push({
        url: response.url(),
        status: response.status(),
        timestamp: Date.now()
      });
    });
  }

  getRequests() {
    return this.requests;
  }

  getResponses() {
    return this.responses;
  }

  getFailedRequests() {
    return this.responses.filter(r => r.status >= 400);
  }

  clear() {
    this.requests = [];
    this.responses = [];
  }

  async simulateNetworkFailure(urlPattern) {
    await this.page.route(urlPattern, route => {
      route.abort('failed');
    });
  }

  async simulateSlowNetwork(urlPattern, delayMs = 3000) {
    await this.page.route(urlPattern, async route => {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      await route.continue();
    });
  }
}
