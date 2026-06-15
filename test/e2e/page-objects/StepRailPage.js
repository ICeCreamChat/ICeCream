/**
 * StepRailPage - 步骤导航栏页面对象
 *
 * 封装步骤导航的所有交互操作
 */
export class StepRailPage {
  constructor(page) {
    this.page = page;

    // 步骤导航容器
    this.stepRail = page.locator('.step-rail');

    // 各步骤按钮
    this.stepButtons = this.stepRail.locator('.step-item');
  }

  /**
   * 获取步骤按钮
   */
  getStepButton(index) {
    return this.stepButtons.nth(index);
  }

  /**
   * 点击指定步骤
   */
  async clickStep(index) {
    await this.getStepButton(index).click();
  }

  /**
   * 获取当前激活的步骤索引
   */
  async getActiveStepIndex() {
    const count = await this.stepButtons.count();
    for (let i = 0; i < count; i++) {
      const isActive = await this.getStepButton(i).evaluate(el =>
        el.classList.contains('active') || el.classList.contains('current')
      );
      if (isActive) {
        return i;
      }
    }
    return -1;
  }

  /**
   * 检查步骤是否完成
   */
  async isStepCompleted(index) {
    return await this.getStepButton(index).evaluate(el =>
      el.classList.contains('completed')
    );
  }

  /**
   * 获取步骤文本
   */
  async getStepText(index) {
    return await this.getStepButton(index).textContent();
  }

  /**
   * 检查步骤导航是否水平滚动（移动端）
   */
  async isHorizontalScrollable() {
    return await this.stepRail.evaluate(el => {
      return el.scrollWidth > el.clientWidth;
    });
  }

  /**
   * 水平滚动到指定步骤（移动端）
   */
  async scrollToStep(index) {
    const stepButton = this.getStepButton(index);
    await stepButton.scrollIntoViewIfNeeded();
  }
}
