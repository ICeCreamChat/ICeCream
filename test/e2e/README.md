# E2E 测试套件使用指南

## 快速开始

### 安装依赖
```bash
npm install
```

### 运行测试

#### 1. 基础运行
```bash
# 运行所有 E2E 测试
npm run test:e2e

# UI 模式运行（推荐，可视化调试）
npm run test:e2e:ui

# 查看测试报告
npm run test:e2e:report
```

#### 2. 调试模式
```bash
# Debug 模式（逐步执行）
npm run test:e2e:debug

# 有头模式（显示浏览器窗口）
npm run test:e2e:headed
```

#### 3. 分项目运行
```bash
# 仅桌面端 Chrome
npm run test:e2e:chromium

# 仅桌面端 Firefox
npm run test:e2e:firefox

# 仅移动端
npm run test:e2e:mobile

# 仅性能测试
npm run test:e2e:performance
```

---

## 测试架构

### 目录结构
```
test/e2e/
├── fixtures/               # 测试数据生成器
│   └── fixture-generator.js
├── helpers/                # 测试辅助工具
│   └── test-helpers.js
├── page-objects/           # 页面对象模式
│   ├── SmartWorkbenchPage.js
│   ├── StepRailPage.js
│   └── ConstraintListPage.js
├── 01-happy-path.spec.js          # 核心流程测试
├── 02-performance.spec.js         # 性能测试
├── 03-mobile-responsive.spec.js   # 移动端测试
└── 04-error-handling.spec.js      # 错误处理测试
```

### Page Object 模式

所有测试使用 Page Object 模式，提高可维护性：

```javascript
import { SmartWorkbenchPage } from './page-objects/SmartWorkbenchPage.js';

test('示例测试', async ({ page }) => {
  const workbench = new SmartWorkbenchPage(page);
  
  await workbench.open();
  await workbench.pasteConstraints('约束文本');
  await workbench.clickParse();
});
```

---

## 测试分类

### 1. 核心流程测试 (01-happy-path.spec.js)
**目标**: 验证完整的用户操作流程

测试场景：
- ✅ 打开智能工作台
- ✅ 粘贴并解析约束
- ✅ 完成约束确认流程
- ✅ 关闭工作台
- ✅ 步骤进度显示
- ✅ 清空约束操作

**适用场景**: 回归测试、冒烟测试

---

### 2. 性能测试 (02-performance.spec.js)
**目标**: 确保性能指标达标

性能基线：
- ⚡ 输入响应: < 200ms
- ⚡ 中型解析 (50条): < 3s
- ⚡ 大型渲染 (120条): < 5s
- ⚡ 滚动帧率: > 30fps
- ⚡ 内存增长: < 100MB

测试场景：
- ✅ 输入响应时间测试
- ✅ 中型数据解析性能
- ✅ 大数据滚动流畅度
- ✅ 大数据渲染性能
- ✅ 页面加载性能
- ✅ 虚拟滚动性能
- ✅ 连续操作稳定性

**适用场景**: 性能回归、优化验证

---

### 3. 移动端测试 (03-mobile-responsive.spec.js)
**目标**: 确保移动端体验流畅

测试设备：
- 📱 iPhone 13 (390x844)
- 📱 Pixel 5 (393x851)
- 🔄 横屏模式 (844x390)

测试场景：
- ✅ 移动端布局显示
- ✅ 步骤栏横向滚动
- ✅ 触摸输入
- ✅ 触摸滚动
- ✅ 虚拟键盘
- ✅ 按钮点击区域 (≥44px)
- ✅ 横屏模式适配
- ✅ 双指缩放控制

**适用场景**: 移动端发布前验证

---

### 4. 错误处理测试 (04-error-handling.spec.js)
**目标**: 验证异常场景的容错能力

测试场景：
- ✅ 空输入处理
- ✅ 格式错误约束
- ✅ 约束冲突检测
- ✅ 网络请求失败
- ✅ 超长文本处理
- ✅ XSS 防护
- ✅ 快速连续操作
- ✅ 错误状态恢复
- ✅ 慢速网络处理

**适用场景**: 稳定性验证、安全测试

---

## 测试数据生成

### 使用 Fixture Generator

```javascript
import { 
  generateSmallDataset,   // 10 条约束
  generateMediumDataset,  // 50 条约束
  generateLargeDataset,   // 120 条约束
  constraintsToText 
} from './fixtures/fixture-generator.js';

// 生成测试数据
const dataset = generateMediumDataset();
const text = constraintsToText(dataset.constraints);

// 在测试中使用
await workbench.pasteConstraints(text);
```

### 特殊数据集

```javascript
import { 
  generateMalformedDataset,    // 格式错误数据
  generateConflictingDataset   // 冲突约束数据
} from './fixtures/fixture-generator.js';
```

---

## 测试辅助工具

### 性能测量

```javascript
import { 
  measureResponseTime,
  measureFPS,
  measureMemoryUsage,
  assertResponseTime,
  assertFPS
} from './helpers/test-helpers.js';

// 测量操作响应时间
const time = await measureResponseTime(async () => {
  await workbench.clickParse();
});

// 断言性能指标
assertResponseTime(time, 200, '解析操作');

// 测量帧率
const fps = await measureFPS(page, 2000);
assertFPS(fps, 30, '滚动操作');
```

### 网络拦截

```javascript
import { NetworkInterceptor } from './helpers/test-helpers.js';

const interceptor = new NetworkInterceptor(page);

// 模拟网络失败
await interceptor.simulateNetworkFailure('**/api/**');

// 模拟慢速网络
await interceptor.simulateSlowNetwork('**/api/**', 3000);

// 获取失败的请求
const failed = interceptor.getFailedRequests();
```

### 控制台监控

```javascript
import { ConsoleCollector } from './helpers/test-helpers.js';

const collector = new ConsoleCollector(page);

// 执行测试操作...

// 检查是否有错误
if (collector.hasErrors()) {
  console.log('错误:', collector.getErrors());
}
```

---

## 编写新测试

### 1. 选择合适的测试文件

- **核心功能**: 添加到 `01-happy-path.spec.js`
- **性能相关**: 添加到 `02-performance.spec.js`
- **移动端特性**: 添加到 `03-mobile-responsive.spec.js`
- **错误场景**: 添加到 `04-error-handling.spec.js`

### 2. 使用 Page Object

```javascript
test('你的新测试', async ({ page }) => {
  const workbench = new SmartWorkbenchPage(page);
  const stepRail = new StepRailPage(page);
  const constraintList = new ConstraintListPage(page);
  
  // 使用页面对象方法
  await workbench.open();
  // ...
});
```

### 3. 添加测试数据

如需新的约束类型，在 `fixture-generator.js` 中添加：

```javascript
const CONSTRAINT_TYPES = [
  '教师连堂要求',
  '你的新约束类型',  // 添加这里
  // ...
];
```

### 4. 截图和报告

```javascript
// 关键步骤截图
await page.screenshot({ 
  path: 'test-results/screenshots/your-test.png' 
});

// 控制台日志
console.log('调试信息:', someValue);
```

---

## CI/CD 集成

### GitHub Actions

测试会在以下情况自动运行：
- ✅ Push 到 main/develop 分支
- ✅ 创建或更新 Pull Request

### 查看测试结果

1. 进入 GitHub Actions 标签页
2. 选择最新的 workflow run
3. 查看各项目的测试结果
4. 下载 Artifacts 查看详细报告和截图

### 本地模拟 CI 环境

```bash
# 设置 CI 环境变量
CI=true npm run test:e2e
```

---

## 常见问题

### Q1: 测试失败怎么办？

1. **查看截图**: `test-results/screenshots/`
2. **查看视频**: `test-results/` 中的 `.webm` 文件
3. **使用 UI 模式**: `npm run test:e2e:ui` 可视化调试
4. **使用 Debug 模式**: `npm run test:e2e:debug` 逐步执行

### Q2: 测试运行很慢？

```bash
# 仅运行特定测试
npx playwright test 01-happy-path

# 仅运行特定项目
npm run test:e2e:chromium

# 并行运行（本地）
npx playwright test --workers=4
```

### Q3: 如何更新 Playwright 浏览器？

```bash
npx playwright install
```

### Q4: 如何跳过特定测试？

```javascript
test.skip('暂时跳过的测试', async ({ page }) => {
  // ...
});
```

### Q5: 如何只运行一个测试？

```javascript
test.only('仅运行这个测试', async ({ page }) => {
  // ...
});
```

---

## 最佳实践

### 1. 测试隔离
- ✅ 每个测试独立运行
- ✅ 使用 `beforeEach` 初始化
- ✅ 不依赖测试执行顺序

### 2. 等待策略
- ✅ 使用 `waitFor` 而非固定 `timeout`
- ✅ 等待元素可见和可交互
- ✅ 等待网络请求完成

### 3. 选择器策略
- ✅ 优先使用 `data-testid`
- ✅ 使用语义化的 `role` 选择器
- ✅ 避免依赖 CSS 类名

### 4. 断言清晰
- ✅ 使用明确的断言消息
- ✅ 一个测试验证一个功能点
- ✅ 使用 `expect` 链式断言

### 5. 截图和日志
- ✅ 关键步骤截图记录
- ✅ 记录性能指标到控制台
- ✅ 失败时自动截图和录屏

---

## 性能优化建议

### 1. 减少等待时间
```javascript
// ❌ 不推荐
await page.waitForTimeout(3000);

// ✅ 推荐
await element.waitFor({ state: 'visible' });
```

### 2. 并行测试
```javascript
// playwright.config.js
workers: process.env.CI ? 1 : 4
```

### 3. 复用浏览器上下文
```javascript
// playwright.config.js
reuseExistingServer: !process.env.CI
```

---

## 相关资源

- [Playwright 官方文档](https://playwright.dev/)
- [测试覆盖率报告](./COVERAGE-REPORT.md)
- [Page Object 模式](https://playwright.dev/docs/pom)
- [测试最佳实践](https://playwright.dev/docs/best-practices)

---

## 维护者

如有问题或建议，请联系测试团队或提交 Issue。

**最后更新**: 2026-06-15
