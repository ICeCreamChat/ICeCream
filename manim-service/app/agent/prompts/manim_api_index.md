Manim Community 常用 API 索引：

- Scene 控制：`add`, `remove`, `play`, `wait`, `clear`, `bring_to_front`, `bring_to_back`。
- 动画：`Create`, `Write`, `FadeIn`, `FadeOut`, `Transform`, `ReplacementTransform`, `GrowFromCenter`, `MoveAlongPath`。
- 几何：`Circle`, `Square`, `Rectangle`, `Triangle`, `Polygon`, `Line`, `Arrow`, `DoubleArrow`, `Vector`, `Dot`, `Angle`, `Arc`。
- 文本：`Text` 用于中文和普通文字；`MathTex` 用于纯公式。
- 排版：`VGroup(...).arrange()`, `move_to`, `next_to`, `to_edge`, `scale_to_fit_width`, `scale_to_fit_height`。
- 坐标：`Axes`, `NumberPlane`, `plot`, `coords_to_point`, `c2p`。

常见禁区：
- 不使用 `ShowCreation`, `TextMobject`, `TexMobject` 等旧版 API。
- 不把 `get_center`, `next_to`, `get_angle` 写成 `self.get_center()`。
- `Angle()` 传入已有线段对象，不传 raw point 或向量表达式。
