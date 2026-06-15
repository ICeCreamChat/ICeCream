import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright 配置 - ICeCream 智能排课工作台 E2E 测试
 *
 * 覆盖三种测试场景：
 * 1. Desktop - 桌面端完整功能测试
 * 2. Mobile - 移动端响应式与触摸交互测试
 * 3. Performance - 性能与大数据量压力测试
 */
export default defineConfig({
  testDir: './test/e2e',

  // 测试超时配置
  timeout: 30 * 1000, // 单个测试 30 秒
  expect: {
    timeout: 5000 // 断言超时 5 秒
  },

  // 失败重试策略
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0, // CI 环境重试 2 次
  workers: process.env.CI ? 1 : undefined,

  // 测试报告
  reporter: [
    ['html', { outputFolder: 'test-results/html' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
    ['list']
  ],

  // 全局测试配置
  use: {
    // 基础 URL
    baseURL: 'http://localhost:3000',

    // 截图与视频
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',

    // 浏览器上下文
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,

    // 动作超时
    actionTimeout: 10000,
    navigationTimeout: 30000,
  },

  // 测试项目配置
  projects: [
    // 桌面端 - Chrome
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 }
      },
    },

    // 桌面端 - Firefox
    {
      name: 'desktop-firefox',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1920, height: 1080 }
      },
    },

    // 移动端 - iPhone 13
    {
      name: 'mobile-iphone',
      use: {
        ...devices['iPhone 13'],
        // 移动端特殊配置
        isMobile: true,
        hasTouch: true,
      },
    },

    // 移动端 - Pixel 5
    {
      name: 'mobile-android',
      use: {
        ...devices['Pixel 5'],
        isMobile: true,
        hasTouch: true,
      },
    },

    // 性能测试项目（仅 Chrome，启用性能指标收集）
    {
      name: 'performance',
      testMatch: '**/02-performance.spec.js',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        // 性能测试专用配置
        launchOptions: {
          args: [
            '--enable-precise-memory-info',
            '--enable-automation',
            '--disable-blink-features=AutomationControlled'
          ]
        }
      },
    },
  ],

  // Web 服务器配置（自动启动测试服务器）
  webServer: {
    command: 'npm start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
