"""Runtime Manim knowledge used by the v5 agent.

The rules here are distilled from the local Manim reference project and kept
as generic API/layout guidance. They are not topic-specific full-scene
templates.
"""

from __future__ import annotations


ALLOWED_SCENE_SELF_METHODS = {
    "add",
    "remove",
    "play",
    "wait",
    "clear",
    "safe_play",
    "bring_to_front",
    "bring_to_back",
    "add_foreground_mobject",
    "add_foreground_mobjects",
    "remove_foreground_mobject",
    "remove_foreground_mobjects",
}

COMMON_MOBJECT_METHODS = {
    "move_to",
    "next_to",
    "to_edge",
    "to_corner",
    "shift",
    "scale",
    "scale_to_fit_width",
    "scale_to_fit_height",
    "set_color",
    "set_fill",
    "set_stroke",
    "set_opacity",
    "set_z_index",
    "get_center",
    "get_angle",
    "get_start",
    "get_end",
    "copy",
    "arrange",
}

CORE_MANIM_RULES = [
    "唯一可渲染类必须是 MainScene(SafeScene, Scene)，辅助类不能继承 Scene。",
    "self 只用于 Scene 控制方法：add/remove/play/wait/clear/safe_play/foreground helpers。",
    "不要把 Mobject 方法写成 self.get_center()/self.next_to()/self.get_angle()；这些方法必须作用在具体对象上。",
    "中文说明、标题、步骤、总结必须使用 Text 或 SafeText；MathTex/Tex 只写公式。",
    "使用 VGroup(...).arrange() 管理文本组，并在放置前限制宽度和高度。",
    "使用全画布浅色教学背景，不要制造黑色外框、黑色留白或内嵌白色展示卡片。",
    "所有主要对象必须位于 16:9 安全区域内，标题、步骤、主体图像、总结分区放置。",
    "三角函数坐标轴必须使用符号刻度，例如 -π、-π/2、0、π/2、π，禁止长小数标签。",
    "动画至少包含两个分阶段动作，并在结尾 self.wait(1)。",
    "用户要求圆形时必须使用 Circle；要求三角形时必须使用 Triangle 或 Polygon。语义对象不能错配。",
]

MANIM_API_GUIDE = """
Scene:
- 在 construct(self) 中创建对象，并使用 self.add/self.play/self.wait 控制时间线。
- 常用动画：Create, Write, FadeIn, FadeOut, Transform, ReplacementTransform, GrowFromCenter。

Mobjects:
- 几何：Circle, Square, Rectangle, Triangle, Polygon, Line, Arrow, DoubleArrow, Vector, Dot, Angle, Arc。
- 文本：Text 用于中文和普通文字；MathTex 用于纯公式；Tex 不要混入中文。
- 排版：VGroup(...).arrange(), move_to, next_to, to_edge, scale_to_fit_width, scale_to_fit_height。

函数图像:
- 使用 Axes 或 NumberPlane，手动添加稀疏符号刻度。
- 曲线、关键点、公式、总结必须分阶段出现。

视觉质量:
- 主体面积要足够大，避免黑边、内框、过小画面。
- 对比度明确，教学蓝作为主色，文字保持深色高可读。
""".strip()


def manim_rules_prompt() -> str:
    return "\n".join(
        [
            "Manim v5 runtime rules:",
            *[f"- {rule}" for rule in CORE_MANIM_RULES],
            "",
            MANIM_API_GUIDE,
        ]
    )
