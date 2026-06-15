/**
 * ConstraintListPage - 约束列表页面对象
 *
 * 封装约束列表的所有交互操作
 */
export class ConstraintListPage {
  constructor(page) {
    this.page = page;

    // 约束列表容器
    this.listContainer = page.locator('.constraint-list');

    // 约束项
    this.constraintItems = this.listContainer.locator('.constraint-item');

    // 搜索/筛选控件
    this.searchInput = page.locator('[data-testid="constraint-search"]');
    this.filterDropdown = page.locator('[data-testid="constraint-filter"]');
  }

  /**
   * 获取约束项数量
   */
  async getCount() {
    return await this.constraintItems.count();
  }

  /**
   * 获取指定索引的约束项
   */
  getItem(index) {
    return this.constraintItems.nth(index);
  }

  /**
   * 获取约束项的文本内容
   */
  async getItemText(index) {
    return await this.getItem(index).textContent();
  }

  /**
   * 获取约束项的优先级
   */
  async getItemPriority(index) {
    const item = this.getItem(index);
    const priorityBadge = item.locator('.priority-badge');
    return await priorityBadge.textContent();
  }

  /**
   * 点击约束项（选中/展开）
   */
  async clickItem(index) {
    await this.getItem(index).click();
  }

  /**
   * 删除指定约束项
   */
  async deleteItem(index) {
    const item = this.getItem(index);
    const deleteButton = item.locator('[data-action="delete"]');
    await deleteButton.click();
  }

  /**
   * 编辑指定约束项
   */
  async editItem(index, newText) {
    const item = this.getItem(index);
    const editButton = item.locator('[data-action="edit"]');
    await editButton.click();

    const editInput = item.locator('input, textarea');
    await editInput.fill(newText);

    const saveButton = item.locator('[data-action="save"]');
    await saveButton.click();
  }

  /**
   * 搜索约束
   */
  async search(query) {
    if (await this.searchInput.isVisible()) {
      await this.searchInput.fill(query);
    }
  }

  /**
   * 按优先级筛选
   */
  async filterByPriority(priority) {
    if (await this.filterDropdown.isVisible()) {
      await this.filterDropdown.selectOption(priority);
    }
  }

  /**
   * 滚动到列表底部
   */
  async scrollToBottom() {
    await this.listContainer.evaluate(el => {
      el.scrollTop = el.scrollHeight;
    });
  }

  /**
   * 滚动到列表顶部
   */
  async scrollToTop() {
    await this.listContainer.evaluate(el => {
      el.scrollTop = 0;
    });
  }

  /**
   * 获取列表滚动位置
   */
  async getScrollPosition() {
    return await this.listContainer.evaluate(el => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight
    }));
  }

  /**
   * 检查约束项是否在视口内
   */
  async isItemInViewport(index) {
    const item = this.getItem(index);
    return await item.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const parent = el.parentElement.getBoundingClientRect();
      return rect.top >= parent.top && rect.bottom <= parent.bottom;
    });
  }

  /**
   * 检查约束项的状态
   */
  async getItemStatus(index) {
    const item = this.getItem(index);
    const hasConflict = await item.evaluate(el => el.classList.contains('conflict'));
    const isValid = await item.evaluate(el => el.classList.contains('valid'));
    const isPending = await item.evaluate(el => el.classList.contains('pending'));

    return {
      hasConflict,
      isValid,
      isPending
    };
  }

  /**
   * 批量选择约束项
   */
  async selectItems(indices) {
    for (const index of indices) {
      const item = this.getItem(index);
      const checkbox = item.locator('input[type="checkbox"]');
      if (await checkbox.isVisible()) {
        await checkbox.check();
      }
    }
  }

  /**
   * 获取所有选中的约束项索引
   */
  async getSelectedIndices() {
    const count = await this.getCount();
    const selected = [];

    for (let i = 0; i < count; i++) {
      const item = this.getItem(i);
      const checkbox = item.locator('input[type="checkbox"]');
      if (await checkbox.isVisible() && await checkbox.isChecked()) {
        selected.push(i);
      }
    }

    return selected;
  }
}
