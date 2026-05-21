"""LLM code writer for Manim Agent v6."""

from __future__ import annotations

import json
import re
from typing import Any, Iterable

from .manim_knowledge import CORE_MANIM_RULES, RULE_PACK_VERSION, manim_rules_prompt, semantic_target_from_brief
from .prompt_loader import API_INDEX_VERSION, PROMPT_PACK_VERSION, build_generation_prompt_pack
from .scene_runtime import runtime_prompt


def extract_code_from_text(text: str) -> str:
    """Extract a Python code block or return the raw text."""
    if not text:
        return ""
    match = re.search(r"```(?:python)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    return (match.group(1) if match else text).strip()


def extract_partial_code_from_text(text: str) -> str:
    """Extract progressively streamed Python code from an unfinished response."""
    if not text:
        return ""
    fence = re.search(r"```(?:python)?\s*", text, re.IGNORECASE)
    if fence:
        partial = text[fence.end():]
        end = partial.find("```")
        if end >= 0:
            partial = partial[:end]
        return partial.lstrip("\r\n")

    starts = [idx for idx in (text.find("from manim"), text.find("import "), text.find("class ")) if idx >= 0]
    if not starts:
        return ""
    return text[min(starts):]


def analyze_current_code(code: str) -> dict[str, Any]:
    return {
        "has_scene": "class " in code and "Scene" in code and "def construct" in code,
        "length": len(code or ""),
        "uses_color": any(color in code for color in ("BLUE", "GREEN", "YELLOW", "WHITE", "RED")),
    }


def iter_code_deltas(code: str, chunk_size: int = 900) -> Iterable[dict[str, Any]]:
    """Yield deterministic chunks for non-streaming fallback progress."""
    if not code:
        return
    total = len(code)
    for start in range(0, total, chunk_size):
        end = min(start + chunk_size, total)
        yield {
            "type": "code_delta",
            "delta": code[start:end],
            "code": code[:end],
            "index": start // chunk_size,
            "done": end >= total,
        }



def _domain_requirements(brief: dict[str, Any], storyboard_spec: dict[str, Any]) -> list[str]:
    """Final clean domain constraints used by the code writer prompt."""
    kind = str(storyboard_spec.get("animation_type") or storyboard_spec.get("kind") or brief.get("animation_type") or "")
    request_text = str(brief.get("message") or "")
    request_lower = request_text.lower()
    story_text = " ".join(
        str(part)
        for shot in (storyboard_spec.get("storyboard") or [])
        if isinstance(shot, dict)
        for part in (shot.get("title"), shot.get("narration"), shot.get("visual"))
        if part
    )
    haystack = f"{request_text} {kind} {story_text}".lower()
    requirements: list[str] = [
        "Do not pass guessed keyword arguments into Manim Mobject setter methods; use documented Manim Community parameters only.",
        "Do not construct VMobject/Mobject with points=...; create the object first, then use set_points_as_corners(...) or use Line/Polygon.",
        "Do not put lists, tuples, strings, or numbers directly into VGroup; use VGroup(*items) and make every item a Mobject.",
    ]

    simple_shape_blockers = ("证明", "推导", "内角", "面积", "对角线", "讲解", "性质", "公式", "proof", "derive", "property")
    is_simple_shape = not any(token in haystack for token in simple_shape_blockers)

    if kind == "geometry_circle" or "圆形" in haystack or "circle" in haystack:
        requirements.extend([
            "Circle must be the dominant visible object, centered and large enough to read.",
            "Do not use Triangle/Polygon as the primary object for a circle request.",
        ])

    if kind in {"geometry_proof", "triangle"} or "三角形" in haystack or "triangle" in haystack:
        requirements.extend([
            "Triangle or Polygon with exactly three vertices must be the dominant visible object.",
            "The triangle should occupy roughly 45%-65% of the visual width with straight high-contrast edges.",
        ])
        if is_simple_shape:
            requirements.append("For a simple triangle prompt, do not create a proof scene or dense derivation.")

    is_trig_definition = (
        any(token in haystack for token in (
            "三角函数", "直角三角", "正弦余弦正切", "正弦、余弦、正切",
            "对边", "邻边", "斜边",
        ))
        or any(token in request_lower for token in ("sin cos tan", "sine cosine tangent", "trigonometric"))
        or all(token in request_lower for token in ("sin", "cos", "tan"))
    )
    if is_trig_definition:
        requirements.extend([
            "For trigonometry definition scenes, build one clear right triangle with named points: right_vertex, theta_vertex, opposite_vertex.",
            "Create named side Line objects: opposite_side, adjacent_side, hypotenuse_side.",
            "Do not use Circle() or a unit-circle visual for trigonometry definitions unless the user explicitly asks for a unit circle; the right triangle must be the dominant subject.",
            "Use Chinese semantic side labels: opposite_label = SafeText('对边'), adjacent_label = SafeText('邻边'), hypotenuse_label = SafeText('斜边'). Avoid a/b/c unless the user explicitly asks for letters.",
            "Every side label must be positioned from its matching Line midpoint, for example opposite_label.move_to(opposite_side.point_from_proportion(0.5) + LEFT * 0.28).",
            "Create theta_angle with Angle(adjacent_side, hypotenuse_side) or a legal Angle/RightAngle object at the target vertex.",
            "Create theta_label or alpha_label and place it near theta_angle or the target vertex; never use to_edge, to_corner, or unrelated absolute move_to for the angle label.",
            "Use exact visible formulas with Chinese side names: sin θ = 对边 / 斜边, cos θ = 邻边 / 斜边, tan θ = 对边 / 邻边.",
            "Keep the formulas in a separate derivation/formula zone; do not overlap the triangle or side labels.",
        ])

    if kind == "square" or "正方形" in haystack or "square" in haystack:
        requirements.extend([
            "Square must be the dominant visible object, centered and large enough to read.",
            "Do not use Circle/Triangle/Polygon as the primary object for a square request.",
        ])
        if is_simple_shape:
            requirements.append("For a simple square prompt, do not create a proof scene or formula-heavy layout.")

    if kind == "function_graph" or any(token in haystack for token in ("正弦函数", "余弦函数", "函数图像", "sine graph", "cosine graph")):
        requirements.extend([
            "Function graph requests must contain a large Axes/NumberPlane and a clearly visible curve with stroke_width >= 5.",
            "Use symbolic pi labels such as -π, -π/2, 0, π/2, π; never show long decimal tick labels.",
            "Do not use MathTex/SafeMathTex for visible Chinese labels or simple formulas; use SafeText/Text with Unicode π.",
            "For a simple sine/cosine graph request, do not add a unit circle unless explicitly requested.",
        ])

    if kind in {"data_chart", "bar_chart", "line_chart"} or any(token in haystack for token in ("柱状图", "销量", "数据图", "bar chart")):
        requirements.extend([
            "Bars must be large, high contrast, and occupy the central teaching area.",
            "For a three-month bar chart, draw exactly three large Rectangle bars with compact labels.",
            "Do not use MathTex/SafeMathTex for data charts; months, numbers, titles, and summaries must use SafeText/Text.",
            "Do not use bars.index(bar), VGroup.index(...), or mobject index lookup for data values.",
        ])

    if kind in {"flow_process", "process_flow"} or any(token in haystack for token in ("流程", "握手", "tcp", "flow", "process")):
        requirements.extend([
            "Flow diagrams should use 2-4 main nodes, 2-4 arrows, and one reusable step banner.",
            "Use VGroup(...).arrange() for nodes and arrows, and reuse or transform labels instead of adding many independent Text objects.",
        ])

    if any(token in haystack for token in ("推导", "证明", "过程", "等差", "公式推导", "derive", "proof")):
        requirements.extend([
            "Derivation animations must use separated zones: definition area, derivation area, visual object area, and conclusion area.",
            "Every stage should be a named VGroup; FadeOut or ReplacementTransform outdated objects before showing the next stage.",
        ])

    if kind == "motion_path" or any(token in haystack for token in ("小球", "抛物", "运动", "轨迹", "projectile")):
        requirements.extend([
            "Physical motion must show trajectory, current object position, velocity/direction arrow, and gravity/acceleration cue.",
            "Prefer a simple ParametricFunction trajectory plus MoveAlongPath; avoid custom VMobject internals or fragile updaters.",
        ])

    return requirements


def build_code_writer_messages(
    brief: dict[str, Any],
    storyboard_spec: dict[str, Any],
    style_preset: dict[str, Any],
    skills: list[dict[str, str]],
    current_code: str = "",
) -> list[dict[str, str]]:
    skill_guidance = "\n".join(f"- {skill['name']}：{skill['guidance']}" for skill in skills)
    reference_specs = brief.get("referenceSpecs") or []
    reference_target = str(brief.get("referenceSemanticTarget") or "")
    reference_conflict = str(brief.get("referenceConflict") or "")
    reference_requirements: list[str] = []
    if reference_specs:
        reference_requirements.extend([
            "Reference images are visual constraints, not assets to embed. Redraw the subject with clean Manim objects.",
            "Do not ignore referenceSpecs. Use them for dominant object type, relative position, line style, and approximate composition.",
            "If referenceSpecs say the subject is centered, place the main Manim object near the visual center and make it large enough.",
            "If the reference and text conflict, text intent wins, but keep the reference as secondary layout/style guidance.",
        ])
        if reference_target == "circle":
            reference_requirements.append("Reference analysis indicates a circle; use Circle() as the dominant object unless text explicitly asks otherwise.")
        elif reference_target == "square":
            reference_requirements.append("Reference analysis indicates a square; use Square() as the dominant object unless text explicitly asks otherwise.")
        elif reference_target == "triangle":
            reference_requirements.append("Reference analysis indicates a triangle; use Triangle() or Polygon() as the dominant object unless text explicitly asks otherwise.")
        if reference_conflict:
            reference_requirements.append(f"Reference conflict note: {reference_conflict}")
    system = (
        "你是资深 Manim Community 工程师和教学动画导演。"
        "只返回一个完整 Python 文件，并放在 python 代码块里。"
        "不要使用文件、网络、子进程、动态执行，也不要导入 manim/math/numpy 之外的库。"
        "唯一可渲染类必须是 MainScene(SafeScene, Scene)。"
        "画面中的所有讲解文字、标题、步骤提示和总结默认使用简体中文。"
        "中文必须使用 Text/SafeText；MathTex/SafeMathTex 只能包含纯公式。"
        "不要使用固定题目整段模板，但必须使用通用 runtime helpers 和 Manim API 规则。"
        "质量优先：主体要足够大、对比明确、避免黑边、避免内嵌白卡片、避免文字重叠。"
    )
    hard_requirements = [
        *CORE_MANIM_RULES,
        "Include the generic runtime helper code exactly once before MainScene.",
        "Do not return a domain-specific canned full-scene template.",
        "Keep all major objects inside the frame and use the full 16:9 canvas.",
        "Reserve explicit layout zones for header, step banner, primary visual, derivation panel, secondary visual, and summary when the storyboard needs them.",
        "For derivation or proof scenes, separate definition, derivation, visual object, and conclusion zones; never let formulas overlap cards or diagrams.",
        "Use VGroup objects for each stage and clean or transform old stage groups before adding the next stage.",
        "Compute Arrow/Line endpoints from visible mobjects; avoid large shift values and keep connectors inside safe margins.",
        "If a helper is needed, define generic helpers such as fit_group_to_zone, place_in_zone, safe_arrow_between, or fade_replace_stage; do not use a topic-specific full-scene template.",
        "Use a light teaching canvas: set self.camera.background_color = '#F7FBFF' or rely on SafeScene.setup.",
        "Do not leave the default black camera background, black letterboxes, or black margins.",
        "Do not place the scene inside a smaller white card or inner presentation frame.",
        "Only use make_panel() as a full-frame background helper, not as a smaller boxed container.",
        "Use at least two staged animations and a final self.wait(1).",
        "Use only valid Manim animation constructors: FadeIn, FadeOut, Create, Write, ReplacementTransform, Transform, GrowArrow, MoveAlongPath, LaggedStart. Do not invent names like Adding, Creating, Drawing, Showing, or Animating.",
        "Use self only for Scene control methods: add, remove, play, wait, clear, safe_play, bring_to_front, bring_to_back, foreground mobject helpers.",
        "Never call Mobject methods on self. Use line.get_angle(), dot.get_center(), mobject.next_to(...), Angle(line1, line2), or vector math instead of self.get_angle/self.get_center/self.next_to.",
        "Angle() must receive existing Line/Arrow mobjects, for example Angle(side_a, side_b). Never pass raw points, get_corner/get_center results, or vector arithmetic into Angle().",
        "All visible non-formula text must be Simplified Chinese unless the user explicitly asks for another language.",
        "Every user-visible Text/SafeText/MathTex/SafeMathTex must be assigned to a stable variable in MainScene.construct, such as title_mob, step_text_mob, summary_mob, axis_label_x, or formula_label.",
        "Do not create anonymous visible text directly inside self.add(), VGroup(), or animation calls; create a named variable first so Manim Studio can select and edit it.",
        "If helper functions return visible text objects, unpack them into stable variables in MainScene.construct, for example header_group, title_mob, subtitle_mob = make_header(...).",
        "If the request asks for a circle, create a Circle object and avoid triangle-only geometry.",
        "If the request asks for a square, create a Square object and avoid circle-only or triangle-only geometry.",
        "If the request asks for a triangle, create a Triangle or Polygon object and avoid circle-only geometry.",
        "If the request asks for sine/cosine axes, use symbolic pi tick labels, not long decimals.",
        "For projectile or physical motion, show trajectory, velocity/direction, and gravity/acceleration cues instead of a static object.",
        "The final rendered frame must visually match the requested primary object, not merely mention it in labels.",
        *reference_requirements,
        *_domain_requirements(brief, storyboard_spec),
    ]
    user = {
        "request": brief.get("message", ""),
        "mode": "modify" if current_code.strip() else "create",
        "storyboardSpec": storyboard_spec,
        "semanticTarget": semantic_target_from_brief(brief),
        "referenceSpecs": reference_specs,
        "referenceSummary": brief.get("referenceSummary", ""),
        "referenceSemanticTarget": reference_target,
        "referenceConflict": reference_conflict,
        "referencePolicy": "参考图只提供构图和对象约束，最终视频必须用 Manim 原生对象重绘，不能直接贴图。",
        "stylePreset": style_preset,
        "runtimeHelpers": runtime_prompt(),
        "manimRules": manim_rules_prompt(),
        "promptPack": build_generation_prompt_pack(),
        "skills": skill_guidance,
        "currentCode": current_code,
        "hardRequirements": hard_requirements,
        "rulePackVersion": RULE_PACK_VERSION,
        "promptPackVersion": PROMPT_PACK_VERSION,
        "apiIndexVersion": API_INDEX_VERSION,
    }
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
    ]


def _response_content(response: Any) -> str:
    choices = getattr(response, "choices", []) or []
    if not choices:
        return ""
    choice = choices[0]
    message = getattr(choice, "message", None)
    if message is None and isinstance(choice, dict):
        message = choice.get("message")
    if isinstance(message, dict):
        return str(message.get("content") or "")
    return str(getattr(message, "content", "") or "")


async def write_scene_code(
    brief: dict[str, Any],
    storyboard_spec: dict[str, Any],
    style_preset: dict[str, Any],
    skills: list[dict[str, str]],
    *,
    ai_client: Any | None,
    model_name: str | None,
    current_code: str = "",
) -> dict[str, Any]:
    if ai_client is None or not model_name:
        return {
            "status": "error",
            "summary": "Manim Agent v6 需要配置 AI 客户端后才能生成场景代码。",
            "code": "",
            "source": "unavailable",
            "codeSource": "none",
            "analysis": analyze_current_code(current_code) if current_code else {},
            "next_actions": ["请配置 DEEPSEEK_API_KEY 并重启 Manim 服务。"],
        }

    try:
        response = await ai_client.chat.completions.create(
            model=model_name,
            messages=build_code_writer_messages(brief, storyboard_spec, style_preset, skills, current_code),
            temperature=0.05,
            stream=False,
        )
        code = extract_code_from_text(_response_content(response))
        if not code:
            raise ValueError("模型没有返回可执行代码")
        return {
            "status": "success",
            "summary": "场景代码生成完成。",
            "code": code,
            "source": "llm_v6",
            "codeSource": "llm_v6",
            "analysis": analyze_current_code(current_code) if current_code else {},
            "next_actions": ["进行静态检查、语义检查和视觉检查。"],
        }
    except Exception as exc:
        return {
            "status": "error",
            "summary": f"场景代码生成失败：{exc}",
            "code": "",
            "source": "llm_v6",
            "codeSource": "llm_v6",
            "analysis": analyze_current_code(current_code) if current_code else {},
            "next_actions": ["请重试生成，或降低动画复杂度。"],
        }
