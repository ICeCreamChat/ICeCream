# 座位安排布局预览重构计划

## 问题分析

当前布局预览（`sp-layout-preview-mini`）存在以下可读性问题：

![当前布局预览截图](screenshot_reference)

### 核心问题

| 问题 | 具体表现 | 影响 |
|------|----------|------|
| **格子颜色区分度差** | 座位（米色 `#f3e4cf`）与过道（橙色 `rgba(245,158,11,0.72)`）色相接近，难以一眼区分 | 用户无法快速判断哪里是座位、哪里是过道 |
| **没有分组视觉提示** | 所有座位外观完全一致，没有利用 `groups` 数据做可视化 | 无法感知"两人一组"、"四人一组"等分组结构 |
| **没有行列编号** | 无行号/列号标识 | 用户无法对照实际教室理解布局 |
| **局部过道标识太弱** | 局部过道仅是 2px 的细线 + 微弱颜色变化 | 容易被忽略 |
| **预览与主视图割裂** | 左侧面板的小方块预览 vs 右侧的拟物化课桌风格完全不同 | 心智负担大，需要"翻译"两种视觉语言 |
| **没有容量统计** | 预览区没有显示"X行×Y列，座位数/过道数" | 用户需要自己数 |
| **空间利用差** | 预览占用面积大但信息密度低——只传达了 seat/aisle 二元信息 | 浪费了宝贵的面板空间 |

---

## 改进目标

1. **3秒可读**：用户一眼就能看出行列数、分组、过道位置
2. **视觉一致**：预览风格与主教室视图保持呼应
3. **信息丰富**：显示容量统计、分组信息、讲台/护法位
4. **交互明确**：可编辑元素有清晰的交互提示

---

## Proposed Changes

### 1. 色彩系统重构

#### [MODIFY] [seating-planner.css](file:///d:/607document/ICeCream/public/css/seating-planner.css)

重新设计预览格子的配色，拉大座位/过道/空位的视觉差异：

```diff
 .sp-layout-preview-cell--seat {
-    background:
-        linear-gradient(90deg, rgba(255, 255, 255, 0.05) 1px, transparent 1px),
-        linear-gradient(180deg, #f3e4cf, #e8d7c0);
-    background-size: 4px 100%, 100% 100%;
-    box-shadow: 0 1px 5px rgba(15, 23, 42, 0.16);
+    background: linear-gradient(180deg, #60a5fa, #3b82f6);
+    border-radius: 3px;
+    box-shadow: 0 1px 3px rgba(59, 130, 246, 0.3);
 }

 .sp-layout-preview-cell--aisle {
-    background: rgba(245, 158, 11, 0.72);
+    background: rgba(148, 163, 184, 0.12);
+    border: 1px dashed rgba(148, 163, 184, 0.25);
+    border-radius: 2px;
 }
```

**设计理由**：
- 座位用明亮的蓝色（与主视图的椅背颜色呼应），饱和度高、辨识度强
- 过道用近透明色 + 虚线边框，与背景融为一体，强调"这里是空的"
- 空位用虚线边框但无填充，语义明确

---

### 2. 分组可视化

#### [MODIFY] [seating-planner.js](file:///d:/607document/ICeCream/public/js/tools/seating-planner.js) — `renderEditableLayoutPreviewGrid()`

利用已有的 `layout.groups` 数据，为同一分组的格子添加相同的 `data-group` 属性和交替配色：

```
原始渲染逻辑 (L4235-4249):
  for (let c = 0; c < layout.cols; c++) {
      cell.className = `sp-layout-preview-cell sp-layout-preview-cell--${...}`;
  }

改进为:
  for (let c = 0; c < layout.cols; c++) {
      const groupId = layout.groups?.[r]?.[c];
      cell.dataset.group = groupId ?? '';
      // 同组交替配色
      if (isSeat && groupId != null) {
          cell.classList.add(groupId % 2 === 0 ? 'sp-layout-preview-cell--group-even' : 'sp-layout-preview-cell--group-odd');
      }
  }
```

#### [MODIFY] [seating-planner.css](file:///d:/607document/ICeCream/public/css/seating-planner.css) — 新增分组样式

```css
/* 分组交替色 */
.sp-layout-preview-cell--group-even {
    background: linear-gradient(180deg, #60a5fa, #3b82f6);
}
.sp-layout-preview-cell--group-odd {
    background: linear-gradient(180deg, #34d399, #10b981);
}
```

**效果**：用户一眼能看出哪些座位属于同一组，不同组通过蓝/绿交替色区分。

---

### 3. 行列编号标注

#### [MODIFY] [seating-planner.js](file:///d:/607document/ICeCream/public/js/tools/seating-planner.js) — `renderEditableLayoutPreviewGrid()`

在预览网格的左侧和顶部分别添加行号和列号标签：

- 左侧添加 `1, 2, 3...` 行号
- 顶部添加 `1, 2, 3...` 列号
- 行号/列号跳过过道行/列（只标注有效行列）

#### [MODIFY] [seating-planner.css](file:///d:/607document/ICeCream/public/css/seating-planner.css)

```css
.sp-layout-preview-row-label,
.sp-layout-preview-col-label {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.6rem;
    color: var(--sp-text-muted);
    opacity: 0.7;
    user-select: none;
}
```

---

### 4. 容量统计摘要

#### [MODIFY] [seating-planner.js](file:///d:/607document/ICeCream/public/js/tools/seating-planner.js) — `renderEditableLayoutPreviewGrid()`

在预览网格上方添加一行摘要信息：

```
📐 7行 × 9列 · 座位 48 · 过道 15 · 分组 24组（2人/组）
```

#### [MODIFY] [seating-planner.css](file:///d:/607document/ICeCream/public/css/seating-planner.css)

```css
.sp-layout-preview-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 6px 0;
    font-size: 0.75rem;
    color: var(--sp-text-muted);
}

.sp-layout-preview-summary-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
}

.sp-layout-preview-summary-value {
    font-weight: 700;
    color: var(--sp-text-secondary);
}
```

---

### 5. 讲台/护法位示意

#### [MODIFY] [seating-planner.js](file:///d:/607document/ICeCream/public/js/tools/seating-planner.js) — `renderEditableLayoutPreviewGrid()`

在预览网格顶部增加一个简化的讲台区域示意：

```
[护法] ─── 讲台 ─── [护法]
```

用简单的 HTML 元素表示，当 `layout.guardians.enabled` 时显示。

---

### 6. 局部过道增强

#### [MODIFY] [seating-planner.css](file:///d:/607document/ICeCream/public/css/seating-planner.css)

增强局部过道的视觉反馈：

```diff
 .sp-layout-preview-local-gap.is-active::before {
-    background: var(--sp-primary);
+    background: var(--sp-primary);
+    box-shadow: 0 0 4px rgba(8, 145, 178, 0.5);
 }

 .sp-layout-preview-local-gap.is-active {
-    background: rgba(8, 145, 178, 0.13);
+    background: rgba(8, 145, 178, 0.18);
     box-shadow: inset 0 0 0 1px rgba(8, 145, 178, 0.28);
 }
```

并且增加局部过道线的粗度（从 2px → 3px），使其更易识别。

---

### 7. 布局预览头部重构

#### [MODIFY] [seating-planner.js](file:///d:/607document/ICeCream/public/js/tools/seating-planner.js) — HTML 模板 (L1106-1119)

重构预览确认面板的头部，添加清晰的标题和 AI 说明文字：

```html
<div id="sp-layout-preview-confirm" class="sp-layout-preview sp-hidden">
    <div class="sp-layout-preview-head">
        <span class="sp-layout-preview-icon">
            <i data-lucide="layout-grid"></i>
        </span>
        <div>
            <strong>AI 布局预览</strong>
            <p id="sp-layout-preview-reply"></p>
        </div>
    </div>
    <div id="sp-layout-preview-summary" class="sp-layout-preview-summary"></div>
    <div id="sp-layout-preview-mini" class="sp-layout-preview-mini"></div>
    <div class="sp-layout-preview-legend">
        <span class="sp-layout-preview-legend-item">
            <span class="sp-layout-preview-legend-dot sp-layout-preview-legend-dot--seat"></span> 座位
        </span>
        <span class="sp-layout-preview-legend-item">
            <span class="sp-layout-preview-legend-dot sp-layout-preview-legend-dot--aisle"></span> 过道
        </span>
    </div>
    <div class="sp-layout-preview-actions">
        <button type="button" class="sp-btn sp-btn--sm" id="sp-layout-preview-cancel">取消</button>
        <button type="button" class="sp-btn sp-btn--sm" id="sp-layout-preview-regenerate">
            <i data-lucide="refresh-cw"></i>
            重新生成
        </button>
        <button type="button" class="sp-btn sp-btn--sm sp-btn--primary" id="sp-layout-preview-assign">
            <i data-lucide="check"></i>
            确认排学生
        </button>
    </div>
</div>
```

#### [MODIFY] [seating-planner.css](file:///d:/607document/ICeCream/public/css/seating-planner.css) — 图例样式

```css
.sp-layout-preview-legend {
    display: flex;
    gap: 12px;
    padding: 4px 0;
    font-size: 0.72rem;
    color: var(--sp-text-muted);
}

.sp-layout-preview-legend-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
}

.sp-layout-preview-legend-dot {
    width: 10px;
    height: 10px;
    border-radius: 2px;
}

.sp-layout-preview-legend-dot--seat {
    background: linear-gradient(180deg, #60a5fa, #3b82f6);
}

.sp-layout-preview-legend-dot--aisle {
    background: rgba(148, 163, 184, 0.12);
    border: 1px dashed rgba(148, 163, 184, 0.25);
}
```

---

## 改进效果对比

| 方面 | 改进前 | 改进后 |
|------|--------|--------|
| 座位颜色 | 米色木纹，与过道橙色难区分 | 蓝色座位，明确突出 |
| 过道颜色 | 橙色实心块 | 透明虚线，自然隐退 |
| 分组显示 | 无 | 蓝/绿交替色，一眼看出组别 |
| 行列标号 | 无 | 左侧行号 + 顶部列号 |
| 容量信息 | 无 | "7×9 · 48座 · 24组" |
| 讲台/护法 | 无 | 简化示意图 |
| 局部过道 | 2px 细线 | 3px + 发光效果 |
| 图例 | 无 | 座位/过道色块说明 |

---

## 涉及文件

| 文件 | 改动范围 | 复杂度 |
|------|----------|--------|
| [seating-planner.css](file:///d:/607document/ICeCream/public/css/seating-planner.css) L804-966 | 预览格子颜色、分组色、图例样式、摘要样式 | 中 |
| [seating-planner.js](file:///d:/607document/ICeCream/public/js/tools/seating-planner.js) L1106-1119 | 预览面板 HTML 结构 | 低 |
| [seating-planner.js](file:///d:/607document/ICeCream/public/js/tools/seating-planner.js) L4180-4299 | `renderEditableLayoutPreviewGrid()` 逻辑 | 高 |
| [seating-planner.js](file:///d:/607document/ICeCream/public/js/tools/seating-planner.js) L4378-4405 | `showLayoutPreviewConfirmation()` 和 `showConfirmedLayoutPreview()` 摘要渲染 | 中 |

---

## Verification Plan

### Automated Tests
- 现有的 `seating-planner-ui.test.js` 和 `seating-layout-route.test.js` 应能继续通过
- 新增预览渲染快照测试确保分组色、行列号正确输出

### Manual Verification
- 通过浏览器打开座位编排页面
- 导入学生名单后点击"生成座位表"
- 确认布局预览的新视觉效果：
  - 座位为蓝/绿交替色，过道为透明
  - 行列编号可见
  - 容量摘要显示正确
  - 局部过道可交互且视觉增强
  - 讲台/护法示意正确
- 确认编辑操作（插入/删除过道、切换局部过道）功能正常

## Open Questions

> [!IMPORTANT]
> **配色方案确认**：提案中用蓝色 (`#3b82f6`) 代表座位、绿色 (`#10b981`) 做分组交替。如果你有其他偏好的配色，请告知。

> [!NOTE]
> **行列编号密集布局**：当行列数很多（如 12×15）时，行列编号可能会占用额外空间。可以选择：
> - A) 始终显示编号
> - B) 仅在行列数 ≤ 10 时显示
> - C) 用 tooltip 替代始终可见的编号
