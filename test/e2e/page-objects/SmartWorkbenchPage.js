/**
 * SmartWorkbenchPage - 智能排课工作台页面对象
 *
 * 封装工作台的所有交互操作
 */
export class SmartWorkbenchPage {
  constructor(page) {
    this.page = page;

    // 工作台容器
    this.workbenchContainer = page.locator('.timetable-smart-workbench');

    // 触发按钮（打开工作台）
    this.openButton = page.locator('[data-action="open-smart-workbench"]');

    // 工作台关闭按钮
    this.closeButton = this.workbenchContainer.locator('[data-action="close-workbench"]');

    // 约束输入区域
    this.textareaInput = this.workbenchContainer.locator('textarea[placeholder*="约束"]');
    this.parseButton = this.workbenchContainer.locator('[data-action="parse-constraints"]');

    // 约束列表
    this.constraintList = this.workbenchContainer.locator('.constraint-list');
    this.constraintItems = this.constraintList.locator('.constraint-item');

    // 操作按钮
    this.confirmButton = this.workbenchContainer.locator('[data-action="confirm-constraints"]');
    this.clearButton = this.workbenchContainer.locator('[data-action="clear-all"]');

    // 状态指示器
    this.statusIndicator = this.workbenchContainer.locator('.status-indicator');
  }

  /**
   * 打开工作台
   */
  async open() {
    await this.openButton.click();
    await this.workbenchContainer.waitFor({ state: 'visible', timeout: 3000 });
  }

  /**
   * 关闭工作台
   */
  async close() {
    await this.closeButton.click();
    await this.workbenchContainer.waitFor({ state: 'hidden', timeout: 3000 });
  }

  /**
   * 判断工作台是否可见
   */
  async isVisible() {
    return await this.workbenchContainer.isVisible();
  }

  /**
   * 粘贴约束文本
   */
  async pasteConstraints(text) {
    await this.textareaInput.click();
    await this.textareaInput.fill(text);
  }

  /**
   * 点击解析按钮
   */
  async clickParse() {
    await this.parseButton.click();
  }

  /**
   * 等待约束解析完成
   */
  async waitForParsed(timeout = 5000) {
    await this.constraintItems.first().waitFor({ state: 'visible', timeout });
  }

  /**
   * 获取约束数量
   */
  async getConstraintCount() {
    return await this.constraintItems.count();
  }

  /**
   * 获取指定索引的约束项
   */
  getConstraintItem(index) {
    return this.constraintItems.nth(index);
  }

  /**
   * 点击确认按钮
   */
  async clickConfirm() {
    await this.confirmButton.click();
  }

  /**
   * 点击清空按钮
   */
  async clickClear() {
    await this.clearButton.click();
  }

  /**
   * 获取状态文本
   */
  async getStatusText() {
    return await this.statusIndicator.textContent();
  }

  /**
   * 执行完整的粘贴→解析→确认流程
   */
  async executeFullFlow(constraintsText) {
    await this.open();
    await this.pasteConstraints(constraintsText);
    await this.clickParse();
    await this.waitForParsed();
    await this.clickConfirm();
  }

  /**
   * 滚动约束列表到指定位置
   */
  async scrollConstraintListTo(position) {
    await this.constraintList.evaluate((el, pos) => {
      el.scrollTop = pos;
    }, position);
  }

  /**
   * 获取约束列表的滚动高度
   */
  async getConstraintListScrollHeight() {
    return await this.constraintList.evaluate(el => el.scrollHeight);
  }

  /**
   * 检查约束项是否在视口内
   */
  async isConstraintItemVisible(index) {
    const item = this.getConstraintItem(index);
    return await item.isVisible();
  }
}
