"""Runtime Manim knowledge used by the v6 agent.

The rules here are distilled from the local ManimCat reference project and
kept as generic API/layout guidance. They are not topic-specific full-scene
templates. This module is the single source for generation prompts, static
checks, and regression-test expectations.
"""

from __future__ import annotations

from typing import Any

from .prompt_loader import API_INDEX_VERSION, PROMPT_PACK_VERSION, build_generation_prompt_pack


RULE_PACK_VERSION = "manimcat-foundation-v6"


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

MOJIBAKE_MARKERS = ("\u9422", "\u6d93", "\u9366", "\u8930", "\ufffd")

RULES: list[dict[str, str]] = [
    {
        "id": "scene_contract",
        "title": "唯一场景合约",
        "generation": "唯一可渲染类必须是 MainScene(SafeScene, Scene)，辅助类不能继承 Scene。",
        "critic": "如果不存在 MainScene，或存在多个可渲染 Scene，必须静态失败。",
        "test": "MainScene(SafeScene) 应被拒绝，MainScene(SafeScene, Scene) 应通过。",
    },
    {
        "id": "scene_self_methods",
        "title": "Scene 与 Mobject 方法归属",
        "generation": "self 只用于 Scene 控制方法；不要把 Mobject 方法写成 self.get_center()/self.next_to()/self.get_angle()。",
        "critic": "扫描 MainScene.construct() 中的 self.<method>()，只允许白名单 Scene 控制方法。",
        "test": "self.get_angle/self.get_center/self.next_to 必须被拦截。",
    },
    {
        "id": "text_formula_split",
        "title": "中文与公式分离",
        "generation": "中文说明、标题、步骤、总结必须使用 Text/SafeText；MathTex/Tex 只写纯公式。",
        "critic": "MathTex/Tex/SafeMathTex 参数中出现中文必须静态失败。",
        "test": "MathTex('中文') 必须被拒绝。",
    },
    {
        "id": "legacy_api_forbidden",
        "title": "旧版 API 禁止",
        "generation": "禁止 ShowCreation、TextMobject、TexMobject、number_scale_val 等旧版 API。",
        "critic": "出现旧版 API 直接静态失败。",
        "test": "ShowCreation 与 TextMobject 必须被拒绝。",
    },
    {
        "id": "api_strictness",
        "title": "API 严格模式",
        "generation": "不要猜测或发明 Manim API；只使用常见 Manim Community 类、方法和参数。",
        "critic": "拦截常见幻觉参数，如 set_x/set_y/set_z(..., aligned_edge=...)。",
        "test": "set_y(..., aligned_edge=DOWN) 必须被拒绝。",
    },
    {
        "id": "axis_config",
        "title": "坐标轴配置",
        "generation": "Axes/NumberPlane 的视觉参数放进 axis_config，三角函数使用稀疏符号刻度。",
        "critic": "长小数坐标标签必须失败，过密自动数字应给 warning。",
        "test": "3.141592653589793 这类长小数必须被拒绝。",
    },
    {
        "id": "layout_zones",
        "title": "教学分区布局",
        "generation": "标题、步骤、主体图像、总结分区放置；用 VGroup(...).arrange() 管理文本组。",
        "critic": "文字过多、布局 helper 缺失或明显重叠风险应给 warning/error。",
        "test": "大量 Text/MathTex 对象应触发 text_density warning。",
    },
    {
        "id": "canvas_quality",
        "title": "全画布浅色教学画面",
        "generation": "使用浅色全画布背景，不要黑边、黑底留白、内嵌白色展示卡片。",
        "critic": "黑色背景/外框应失败，明显内嵌展示卡应 warning。",
        "test": "background_color = BLACK 必须被拒绝。",
    },
    {
        "id": "semantic_object_match",
        "title": "语义对象匹配",
        "generation": "用户要求圆形必须使用 Circle；正方形必须使用 Square；三角形必须使用 Triangle/Polygon。",
        "critic": "圆形/正方形/三角形等请求和代码主对象错配必须失败。",
        "test": "圆形请求不能只生成 Triangle，正方形请求不能只生成 Circle。",
    },
    {
        "id": "animation_minimum",
        "title": "基本动画节奏",
        "generation": "动画至少包含两个分阶段动作，并在结尾 self.wait(1)。",
        "critic": "空场景必须失败，过短/主体过小交给视觉检查。",
        "test": "只有 wait 的空 construct 必须被拒绝。",
    },
]

CORE_MANIM_RULES = [rule["generation"] for rule in RULES]

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
            f"Manim v6 runtime rules from ManimCat foundation ({RULE_PACK_VERSION}):",
            f"Prompt pack: {PROMPT_PACK_VERSION}; API index: {API_INDEX_VERSION}",
            *[f"- [{rule['id']}] {rule['generation']}" for rule in RULES],
            "",
            MANIM_API_GUIDE,
            "",
            build_generation_prompt_pack(),
        ]
    )


def rule_ids() -> list[str]:
    return [rule["id"] for rule in RULES]


def rule_by_id(rule_id: str) -> dict[str, str]:
    for rule in RULES:
        if rule["id"] == rule_id:
            return rule
    return {"id": rule_id, "title": rule_id, "generation": "", "critic": "", "test": ""}


def rule_hint(rule_id: str, fallback: str = "") -> str:
    rule = rule_by_id(rule_id)
    return rule.get("critic") or rule.get("generation") or fallback


def semantic_target_from_brief(brief: dict[str, Any] | None) -> str:
    """Return the primary visual object expected by a brief."""
    brief = brief or {}
    spec = brief.get("storyboardSpec") or brief.get("spec") or {}
    kind = str(spec.get("kind") or spec.get("animation_type") or brief.get("animation_type") or "").lower()
    message = str(brief.get("message") or "").lower()
    objects = " ".join(str(item).lower() for item in brief.get("target_objects") or spec.get("objects") or [])

    if kind == "geometry_circle" or "circle" in message or "圆" in message or "circle" in objects:
        return "circle"
    if kind == "square" or "square" in message or "正方形" in message or "square" in objects:
        return "square"
    if kind in {"triangle", "geometry_proof"} or "triangle" in message or "三角" in message or "triangle" in objects:
        return "triangle"
    if kind == "function_graph" or any(token in message for token in ("正弦", "余弦", "函数", "sin", "cos")):
        return "function_graph"
    if kind in {"data_chart", "bar_chart", "line_chart"} or any(token in message for token in ("柱状图", "销量", "数据")):
        return "data_chart"
    if kind in {"motion_path", "physics_motion"} or any(token in message for token in ("小球", "抛物", "运动", "轨迹")):
        return "motion_path"
    if kind in {"flow_process", "process_flow"} or any(token in message for token in ("流程", "握手", "tcp")):
        return "flow"
    reference_target = str(brief.get("referenceSemanticTarget") or "").lower()
    if reference_target in {"circle", "square", "triangle", "function_graph", "data_chart", "motion_path", "flow"}:
        return reference_target
    for reference_spec in brief.get("referenceSpecs") or []:
        if not isinstance(reference_spec, dict):
            continue
        subject = reference_spec.get("subject") or {}
        likely_shape = str(subject.get("likelyShape") or "").lower()
        if likely_shape in {"circle", "square", "triangle"}:
            return likely_shape
    return ""
