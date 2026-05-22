"""Repair helpers for Manim Agent v6."""

from __future__ import annotations

import ast
import json
import re
from typing import Any, Callable

from .code_writer import extract_code_from_text
from .critic import critique_code
from .manim_knowledge import RULE_PACK_VERSION, manim_rules_prompt, rule_hint, semantic_target_from_brief
from .prompt_loader import build_repair_prompt_pack


Fixer = Callable[[str, dict[str, Any]], str]


def _compact_trig_label_text(text: str) -> str:
    return re.sub(r"[\s:=：=（）()\\{}_\-]+", "", str(text).strip().lower())


def _trig_side_from_label(var_name: str, text: str) -> str | None:
    var = var_name.lower()
    compact = _compact_trig_label_text(text)
    non_side_var_tokens = ("formula", "summary", "title", "subtitle", "header", "banner", "step")
    if any(token in var for token in non_side_var_tokens):
        return None
    if any(token in compact.lower() for token in ("sin", "cos", "tan")):
        return None
    if any(token in compact for token in ("=", "/", "＝", "：", ":", "；", ";")) and len(compact) > 6:
        return None
    if len(compact) > 10 and "label" not in var:
        return None
    for side, tokens in {
        "a": ("对边", "opposite"),
        "b": ("邻边", "adjacent"),
        "c": ("斜边", "hypotenuse"),
    }.items():
        if any(token in var or token in compact for token in tokens):
            return side
    if "opposite" in var:
        return "a"
    if "adjacent" in var:
        return "b"
    if "hypotenuse" in var:
        return "c"
    if compact in {"a", "sidea"}:
        return "a"
    if compact in {"b", "sideb"}:
        return "b"
    if compact in {"c", "sidec"}:
        return "c"
    return None


def _failure_category(report: dict[str, Any], stderr: str = "") -> str:
    codes = {str(item.get("code", "")) for item in report.get("issues", []) + report.get("findings", [])}
    text = f"{report.get('summary', '')} {stderr}".lower()
    if any(code.startswith("trig_") for code in codes):
        return "几何语义或视觉错配"
    if any(code.startswith("semantic_") or code.startswith("visual_") for code in codes):
        return "语义或视觉错配"
    if "latex" in text or "tex" in text:
        return "LaTeX/公式渲染问题"
    if (
        "unexpected keyword" in text
        or "mobject.__getattr__" in text
        or "invalid_manim_keyword" in codes
        or "unsafe_mobject_setter_keyword" in codes
        or "invalid_vgroup_child" in codes
    ):
        return "Manim API 或参数调用错误"
    if "attributeerror" in text or "syntax" in text or "nameerror" in text or "unknown_scene_method" in codes:
        return "Manim API 或代码错误"
    if "black" in text or "contrast" in text or "视觉" in text or "预览" in text:
        return "视觉质量问题"
    if "安全" in text or "system" in text or "security" in codes:
        return "安全规则问题"
    return "静态质量问题"


def build_repair_observation(
    code: str,
    report: dict[str, Any],
    *,
    stderr: str = "",
    attempt: int = 1,
    brief: dict[str, Any] | None = None,
    storyboard_spec: dict[str, Any] | None = None,
    style_preset: dict[str, Any] | None = None,
) -> dict[str, Any]:
    issues = report.get("issues") or report.get("findings") or []
    root = "; ".join(str(item.get("message", "")) for item in issues[:5]) or stderr[-500:] or report.get("summary", "")
    rule_codes = [str(item.get("code", "")) for item in issues if item.get("code")]
    repair_rules = [
        {"id": code, "hint": rule_hint(code, str(item.get("hint", "")))}
        for code, item in zip(rule_codes, [item for item in issues if item.get("code")])
    ]
    return {
        "status": report.get("status", "error"),
        "summary": report.get("summary", ""),
        "failureCategory": _failure_category(report, stderr),
        "issues": issues,
        "stderr": stderr[-1600:] if stderr else "",
        "stderrSummary": stderr[-500:] if stderr else "",
        "attempt": attempt,
        "root_cause_hint": root,
        "ruleIds": rule_codes,
        "safe_retry": "返回一个完整、更安全的 Manim 文件，保持同一个 MainScene 合约。",
        "rulePackVersion": RULE_PACK_VERSION,
        "repairRules": repair_rules,
        "semanticTarget": semantic_target_from_brief(brief),
        "referenceSpecs": (brief or {}).get("referenceSpecs", []),
        "referenceSummary": (brief or {}).get("referenceSummary", ""),
        "referenceSemanticTarget": (brief or {}).get("referenceSemanticTarget", ""),
        "referenceConflict": (brief or {}).get("referenceConflict", ""),
        "brief": brief or {},
        "storyboardSpec": storyboard_spec or {},
        "stylePreset": style_preset or {},
        "currentCodeLength": len(code or ""),
    }


def static_repair_once(code: str, observation: dict[str, Any]) -> str:
    """Small non-template repairs for common safety/import issues."""
    repaired = code or ""
    if "from manim import" not in repaired:
        repaired = "from manim import *\nimport math\nimport numpy as np\n\n" + repaired
    if "import math" not in repaired:
        repaired = repaired.replace("from manim import *", "from manim import *\nimport math", 1)
    if "import numpy as np" not in repaired:
        repaired = repaired.replace("import math", "import math\nimport numpy as np", 1)

    repaired = re.sub(
        r"^\s*(?:import|from)\s+(os|sys|subprocess|socket|pathlib|shutil|ctypes|signal|multiprocessing|threading|asyncio|requests|urllib|http|ftplib|paramiko)\b.*$",
        "",
        repaired,
        flags=re.MULTILINE,
    )
    repaired = re.sub(r"(?:eval|exec|compile|__import__|open|globals|locals|vars|dir|getattr|setattr|delattr)\s*\([^)]*\)", "None", repaired)
    repaired = re.sub(r"3\.141592653589793\d*", "PI", repaired)
    repaired = re.sub(r"1\.5707963267948966\d*", "PI / 2", repaired)
    repaired = re.sub(r"-3\.141592653589793\d*", "-PI", repaired)
    repaired = re.sub(r"-1\.5707963267948966\d*", "-PI / 2", repaired)
    repaired = re.sub(r"background_color\s*=\s*BLACK", "background_color = '#F7FBFF'", repaired)
    repaired = re.sub(r"fill_color\s*=\s*BLACK", "fill_color = '#F7FBFF'", repaired)
    repaired = re.sub(
        r"(?ms)^\s*if\s+__name__\s*==\s*['\"]__main__['\"]\s*:\s*(?:\n\s+.*?)(?=\n\S|\Z)",
        "",
        repaired,
    )
    repaired = repaired.replace("__main__", "main")

    repaired = re.sub(
        r"class\s+SafeScene\s*\(\s*(?:Scene|SafeScene\s*,\s*Scene|Scene\s*,\s*SafeScene)\s*\)\s*:",
        "class SafeScene:",
        repaired,
    )
    repaired = re.sub(
        r"class\s+MainScene\s*\(\s*SafeScene\s*\)\s*:",
        "class MainScene(SafeScene, Scene):",
        repaired,
    )
    repaired = re.sub(
        r"class\s+MainScene\s*\(\s*Scene\s*\)\s*:",
        "class MainScene(SafeScene, Scene):",
        repaired,
    )
    if "class MainScene" not in repaired:
        match = re.search(r"class\s+([A-Za-z_]\w*)\s*\(\s*(?:SafeScene\s*,\s*)?Scene\s*\)\s*:", repaired)
        if match:
            repaired = repaired[: match.start()] + "class MainScene(SafeScene, Scene):" + repaired[match.end():]
    return repaired


def _trig_side_label_repair(code: str) -> tuple[str, list[dict[str, str]]]:
    """Bind simple trigonometry side labels to their canonical Line midpoint."""
    if not code or not all(name in code for name in ("opposite_side", "adjacent_side", "hypotenuse_side")):
        return code, []

    side_specs = {
        "a": ("opposite_side", "LEFT * 0.28", "对边"),
        "b": ("adjacent_side", "DOWN * 0.28", "邻边"),
        "c": ("hypotenuse_side", "UP * 0.28", "斜边"),
    }
    label_pattern = re.compile(
        r"(?m)^(?P<indent>\s*)(?P<var>[A-Za-z_]\w*)\s*=\s*"
        r"(?P<ctor>Text|SafeText|MathTex|SafeMathTex|Tex)\(\s*(?P<quote>['\"])(?P<label>[^'\"]+)(?P=quote)"
    )
    repaired = code
    patches: list[dict[str, str]] = []
    insertions: list[tuple[int, str]] = []

    for match in list(label_pattern.finditer(code)):
        var_name = match.group("var")
        label = match.group("label").strip()
        side = _trig_side_from_label(var_name, label)
        spec = side_specs.get(side or "")
        if not spec:
            continue
        line_var, offset, semantic_name = spec
        bind_line = (
            f"{match.group('indent')}{var_name}.move_to("
            f"{line_var}.point_from_proportion(0.5) + {offset})"
        )
        position_pattern = re.compile(
            rf"(?m)^\s*{re.escape(var_name)}\s*\.\s*"
            rf"(?:move_to|next_to|to_edge|to_corner|shift)\s*\([^\n]*\)\s*$"
        )
        did_bind = False

        def _replace_position(position_match: re.Match[str]) -> str:
            nonlocal did_bind
            if not did_bind:
                did_bind = True
                return bind_line
            return f"{match.group('indent')}# Studio repair removed older floating placement for {var_name}"

        repaired, count = position_pattern.subn(_replace_position, repaired)
        if count == 0:
            line_end = code.find("\n", match.end())
            if line_end == -1:
                line_end = len(code)
            insertions.append((line_end, "\n" + bind_line))
        patches.append({
            "id": "trig_side_label_midpoint_binding",
            "summary": f"已将 {semantic_name} 标签绑定到对应边的中点附近。",
        })

    for position, text in sorted(insertions, reverse=True):
        repaired = repaired[:position] + text + repaired[position:]

    return repaired, patches


def _trig_formula_repair(code: str) -> tuple[str, list[dict[str, str]]]:
    """Rewrite visible trig formulas to the canonical semantic ratios."""
    if not re.search(r"\b(?:sin|cos|tan)\b|\\(?:sin|cos|tan)", code):
        return code, []

    def _replace_literal(match: re.Match[str]) -> str:
        quote = match.group("quote")
        text = match.group("text")
        lower = text.lower()
        if not any(token in lower for token in ("sin", "cos", "tan", "\\sin", "\\cos", "\\tan")):
            return match.group(0)
        if all(token in lower for token in ("sin", "cos", "tan")):
            replacement = "sin θ = 对边 / 斜边；cos θ = 邻边 / 斜边；tan θ = 对边 / 邻边"
        elif "sin" in lower or "\\sin" in lower:
            replacement = "sin θ = 对边 / 斜边"
        elif "cos" in lower or "\\cos" in lower:
            replacement = "cos θ = 邻边 / 斜边"
        else:
            replacement = "tan θ = 对边 / 邻边"
        return f"{match.group('prefix')}{quote}{replacement}{quote}"

    literal_pattern = re.compile(
        r"(?P<prefix>\b(?:Text|SafeText|MathTex|SafeMathTex|Tex)\(\s*)"
        r"(?P<quote>['\"])(?P<text>[^'\"\n]*(?:\\?sin|\\?cos|\\?tan)[^'\"\n]*)(?P=quote)",
        re.IGNORECASE,
    )
    repaired, count = literal_pattern.subn(_replace_literal, code)
    if count == 0 or repaired == code:
        return code, []
    return repaired, [{
        "id": "trig_formula_semantics_rewrite",
        "summary": "已把三角函数公式改为 sin θ=对边/斜边、cos θ=邻边/斜边、tan θ=对边/邻边。",
    }]


def _replace_construct_body(code: str, body: str) -> str:
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return code
    target_method: ast.FunctionDef | None = None
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef) or node.name != "MainScene":
            continue
        for item in node.body:
            if isinstance(item, ast.FunctionDef) and item.name == "construct":
                target_method = item
                break
    if target_method is None:
        return code
    lines = code.splitlines()
    body_indent = " " * ((target_method.body[0].col_offset if target_method.body else target_method.col_offset + 4))
    start = (target_method.body[0].lineno - 1) if target_method.body else target_method.lineno
    end = target_method.end_lineno or start
    replacement = [
        (body_indent + line if line.strip() else "")
        for line in body.strip("\n").splitlines()
    ]
    return "\n".join(lines[:start] + replacement + lines[end:])


def _trig_semantic_rescue(code: str) -> tuple[str, list[dict[str, str]]]:
    """Replace only MainScene.construct with a conservative right-triangle explanation."""
    if "class MainScene" not in code:
        return code, []
    text_call = "SafeText" if "def SafeText" in code else "Text"
    formula_call = "SafeText" if "def SafeText" in code else "Text"
    rescue_body = f'''
self.camera.background_color = "#F7FBFF"
title_mob = {text_call}("三角函数的定义", font_size=34, color="#0284C7").to_edge(UP)
subtitle_mob = {text_call}("先确定目标角 θ，再找对边、邻边和斜边。", font_size=24, color="#64748B").next_to(title_mob, DOWN, buff=0.16)

right_vertex = LEFT * 2.2 + DOWN * 1.25
theta_vertex = RIGHT * 2.2 + DOWN * 1.25
top_vertex = LEFT * 2.2 + UP * 1.35

adjacent_side = Line(right_vertex, theta_vertex, color="#0284C7", stroke_width=5)
opposite_side = Line(right_vertex, top_vertex, color="#16A34A", stroke_width=5)
hypotenuse_side = Line(theta_vertex, top_vertex, color="#F97316", stroke_width=5)
triangle = VGroup(adjacent_side, opposite_side, hypotenuse_side)

right_angle = RightAngle(adjacent_side, opposite_side, length=0.28, color="#334155")
theta_adjacent_ray = Line(theta_vertex, right_vertex)
theta_hypotenuse_ray = Line(theta_vertex, top_vertex)
theta_angle = Angle(theta_hypotenuse_ray, theta_adjacent_ray, radius=0.42, color="#E11D48")
theta_label = {text_call}("θ", font_size=28, color="#E11D48")
theta_label.move_to(theta_vertex + LEFT * 0.46 + UP * 0.33)

opposite_label = {text_call}("对边", font_size=24, color="#166534")
opposite_label.move_to(opposite_side.point_from_proportion(0.5) + LEFT * 0.34)
adjacent_label = {text_call}("邻边", font_size=24, color="#075985")
adjacent_label.move_to(adjacent_side.point_from_proportion(0.5) + DOWN * 0.34)
hypotenuse_label = {text_call}("斜边", font_size=24, color="#C2410C")
hypotenuse_label.move_to(hypotenuse_side.point_from_proportion(0.5) + RIGHT * 0.34)

diagram_group = VGroup(
    triangle, right_angle, theta_angle, theta_label,
    opposite_label, adjacent_label, hypotenuse_label,
)
diagram_group.move_to(LEFT * 1.75 + DOWN * 0.08)

sin_formula = {formula_call}("sin θ = 对边 / 斜边", font_size=26, color="#1D2530")
cos_formula = {formula_call}("cos θ = 邻边 / 斜边", font_size=26, color="#1D2530")
tan_formula = {formula_call}("tan θ = 对边 / 邻边", font_size=26, color="#1D2530")
formula_group = VGroup(sin_formula, cos_formula, tan_formula).arrange(DOWN, aligned_edge=LEFT, buff=0.24)
formula_group.to_edge(RIGHT, buff=0.8).shift(UP * 0.1)

summary_mob = {text_call}("记忆顺序：正弦看对边，余弦看邻边，正切是对边比邻边。", font_size=24, color="#475569")
summary_mob.to_edge(DOWN, buff=0.45)

self.add(title_mob, subtitle_mob, diagram_group, formula_group, summary_mob)
self.wait(1)
'''
    repaired = _replace_construct_body(code, rescue_body)
    if repaired == code:
        return code, []
    return repaired, [{
        "id": "trig_semantic_rescue_block",
        "summary": "已用稳定的直角三角函数语义子块重建图解，保留外层 Manim 场景结构。",
    }]


def _replace_chinese_mathtex(match: re.Match[str]) -> str:
    func = match.group("func")
    quote = match.group("quote")
    text = match.group("text")
    if not re.search(r"[\u4e00-\u9fff]", text):
        return match.group(0)
    return f"SafeText({quote}{text}{quote}"


def patch_first_repair(code: str, report: dict[str, Any]) -> dict[str, Any]:
    """Apply deterministic small patches before asking the LLM.

    These patches are deliberately narrow: they only address errors that are
    clear from static analysis and should not change the requested animation.
    """
    repaired = static_repair_once(code, {})
    patches: list[dict[str, str]] = []

    before = repaired
    repaired = re.sub(
        r"\b(?P<func>MathTex|Tex|SafeMathTex)\(\s*(?P<quote>['\"])(?P<text>[^'\"]*[\u4e00-\u9fff][^'\"]*)(?P=quote)",
        _replace_chinese_mathtex,
        repaired,
    )
    if repaired != before:
        patches.append({
            "id": "mathtex_chinese_to_safetext",
            "summary": "已把包含中文的 MathTex/Tex 调用改为 SafeText。",
        })

    before = repaired
    repaired = re.sub(r"\bShowCreation\s*\(", "Create(", repaired)
    repaired = re.sub(r"\bTextMobject\s*\(", "Text(", repaired)
    repaired = re.sub(r"\bTexMobject\s*\(", "MathTex(", repaired)
    if repaired != before:
        patches.append({
            "id": "legacy_api_to_community_api",
            "summary": "已把旧版 Manim API 改为 Community API。",
        })

    before = repaired
    repaired = re.sub(r",\s*aligned_edge\s*=\s*[^,)]+", "", repaired)
    if repaired != before:
        patches.append({
            "id": "remove_invalid_aligned_edge",
            "summary": "已移除 set_x/set_y/set_z 不支持的 aligned_edge 参数。",
        })

    issue_codes = {str(item.get("code", "")) for item in report.get("issues", []) + report.get("findings", [])}
    trig_issue_codes = {code for code in issue_codes if code.startswith("trig_")}
    if trig_issue_codes:
        before = repaired
        repaired, trig_patches = _trig_side_label_repair(repaired)
        if repaired != before:
            patches.extend(trig_patches)
        before = repaired
        repaired, formula_patches = _trig_formula_repair(repaired)
        if repaired != before:
            patches.extend(formula_patches)
        # If semantic trig issues reached repair, prefer a deterministic right-triangle
        # sub-block over repeatedly asking the LLM to nudge free-floating labels.
        if trig_issue_codes & {
            "trig_side_label_unbound",
            "trig_side_label_missing",
            "trig_formula_mapping_mismatch",
            "trig_formula_semantics_missing",
            "trig_angle_label_unbound",
            "trig_angle_label_unbound_to_bisector",
            "trig_angle_label_missing",
            "trig_angle_marker_missing",
            "trig_angle_ray_orientation_missing",
            "trig_angle_arc_reversed",
            "trig_triangle_missing",
            "trig_circle_distractor",
        }:
            before = repaired
            repaired, rescue_patches = _trig_semantic_rescue(repaired)
            if repaired != before:
                patches.extend(rescue_patches)

    return {"code": repaired, "patches": patches}


async def llm_repair_once(
    code: str,
    observation: dict[str, Any],
    *,
    ai_client: Any | None,
    model_name: str | None,
) -> str:
    if ai_client is None or not model_name:
        return static_repair_once(code, observation)

    system = (
        "你负责修复 Manim Community Python 文件。"
        "只返回一个完整 Python 文件，并放在 python 代码块里。"
        "不要引入文件、网络、子进程、动态执行，也不要引入额外可渲染 Scene 类。"
        "修复必须保持用户语义：圆形就是圆形，三角形就是三角形，函数图像必须有清晰坐标系和曲线。"
        "如果是视觉质量问题，要放大主体、加粗线条、提高对比度，并移除黑边或内嵌白卡。"
        "如果是 LaTeX/公式渲染失败，优先把简单可见公式改为 Text/SafeText，例如 y = sin(x)。"
    )
    user = {
        "observation": observation,
        "currentCode": code,
        "manimRules": manim_rules_prompt(),
        "promptPack": build_repair_prompt_pack(),
        "rulePackVersion": RULE_PACK_VERSION,
        "requirements": [
            "For trig_ semantic issues, rebuild the triangle semantics: create opposite_side, adjacent_side, hypotenuse_side Line objects; place α/θ near Angle/RightAngle; place every side label at its Line midpoint; use exact formulas sin α = 对边/斜边, cos α = 邻边/斜边, tan α = 对边/邻边.",
            "For trig angle repairs, never call Angle(adjacent_side, hypotenuse_side) directly. Create two helper rays from the same target vertex, such as theta_adjacent_ray = Line(theta_vertex, right_vertex) and theta_hypotenuse_ray = Line(theta_vertex, top_vertex), then call Angle(theta_hypotenuse_ray, theta_adjacent_ray). If the arc is outside or reversed, swap the two helper ray arguments instead of nudging labels.",
            "Place theta_label/alpha_label from theta_vertex/alpha_vertex along the interior angle direction, for example theta_label.move_to(theta_vertex + LEFT * 0.45 + UP * 0.32). Do not use next_to(theta_angle, UP) as the only placement.",
            "Keep MainScene(SafeScene, Scene) as the only renderable Scene.",
            "Use Text/SafeText for Chinese and MathTex only for formulas.",
            "Keep the storyboard semantics unchanged.",
            "Fix the reported static, visual, semantic, or render issue.",
            "If the issue is connector_offscreen/object_clipped/unsafe_edge_contact, recompute connector endpoints from visible mobjects and keep every object inside safe margins.",
            "If the issue is panel_overlap/text_overlap/derivation_layout_missing, restructure the scene into separate layout zones instead of moving one object slightly.",
            "If the issue is stage_residue/stage_cleanup_missing, group each stage with VGroup and FadeOut or ReplacementTransform old stage groups before showing the next stage.",
            "If the observation contains AttributeError for self.<method>(), remove that call.",
            "Use legal Manim object methods such as line.get_angle(), dot.get_center(), mobject.next_to(...), Angle(line1, line2), or explicit vector math.",
            "Remove black borders, default black backgrounds, and inner white presentation cards.",
            "For triangle requests, keep a large three-vertex Triangle/Polygon as the central subject and avoid circular primary shapes.",
            "For function graph requests, make the graph dominate the visual area; use stroke_width >= 5, sparse symbolic pi labels, remove unit-circle distractors unless explicitly requested, and replace visible MathTex/SafeMathTex labels with SafeText/Text using Unicode π.",
            "For data charts, remove MathTex/SafeMathTex from visible labels; months, numbers, titles, and summaries must use SafeText/Text.",
            "If code uses set_x/set_y/set_z with aligned_edge, remove that keyword and reposition with move_to, next_to, align_to, or explicit center coordinates.",
            "If a Manim call fails with unexpected keyword, remove the unsupported keyword and replace it with legal positioning, sizing, or set_points_as_corners code.",
            "If VGroup contains a list, tuple, string, number, or other non-Mobject value, convert each visible item to Text/SafeText/MathTex/SafeMathTex and use VGroup(*items).",
            "Do not pass guessed keyword arguments into Mobject setter methods; use positional arguments or documented Manim Community parameters only.",
            "If any issue code starts with trig_, rebuild the triangle semantics instead of nudging text: create named opposite_side, adjacent_side, and hypotenuse_side Line objects; create helper rays from the same target vertex for alpha_angle/theta_angle; call Angle(theta_hypotenuse_ray, theta_adjacent_ray) or Angle(alpha_hypotenuse_ray, alpha_adjacent_ray) so the arc is inside the triangle; place alpha_label/theta_label with alpha_vertex/theta_vertex plus an interior-angle offset; place side labels at each side midpoint; keep formulas exact: sin α = 对边/斜边, cos α = 邻边/斜边, tan α = 对边/邻边. Never float α/a/b/c with to_edge/to_corner, unrelated absolute move_to, or next_to(angle, UP) alone.",
            "For trig_circle_distractor or trigonometry definition repairs, remove Circle()/unit-circle visuals unless the original user request explicitly says 单位圆 or unit circle; the dominant visual must be a right triangle.",
            "For projectile motion, include a visible trajectory, moving ball, velocity/direction arrow, and gravity/acceleration cue; prefer ParametricFunction plus MoveAlongPath over custom VMobject internals or fragile updaters.",
        ],
    }
    response = await ai_client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
        ],
        temperature=0.05,
        stream=False,
    )
    fixed = extract_code_from_text(response.choices[0].message.content)
    return fixed or static_repair_once(code, observation)


async def repair_code_async(
    code: str,
    report: dict[str, Any],
    *,
    stderr: str = "",
    max_attempts: int = 4,
    brief: dict[str, Any] | None = None,
    storyboard_spec: dict[str, Any] | None = None,
    style_preset: dict[str, Any] | None = None,
    ai_client: Any | None = None,
    model_name: str | None = None,
) -> dict[str, Any]:
    if report.get("status") != "error":
        return {
            "status": "success",
            "summary": "代码已通过静态检查，无需自动修复。",
            "attempts": 0,
            "code": code,
            "critic": report,
            "observations": [],
        }

    current = code
    last_report = report
    observations: list[dict[str, Any]] = []

    for attempt in range(1, max_attempts + 1):
        observation = build_repair_observation(
            current,
            last_report,
            stderr=stderr,
            attempt=attempt,
            brief=brief,
            storyboard_spec=storyboard_spec,
            style_preset=style_preset,
        )
        patched = patch_first_repair(current, last_report)
        if patched["patches"]:
            current = patched["code"]
            observation["patches"] = patched["patches"]
            patched_report = critique_code(current, brief or {})
            if patched_report["status"] != "error":
                observations.append(observation)
                return {
                    "status": "success",
                    "summary": "代码已通过确定性补丁完成自动修复。",
                    "attempts": attempt,
                    "code": current,
                    "critic": patched_report,
                    "observations": observations,
                }
            last_report = patched_report
            observation["postPatchReport"] = patched_report
        observations.append(observation)
        current = await llm_repair_once(current, observation, ai_client=ai_client, model_name=model_name)
        last_report = critique_code(current, brief or {})
        if last_report["status"] != "error":
            return {
                "status": "success",
                "summary": "代码已完成自动修复。",
                "attempts": attempt,
                "code": current,
                "critic": last_report,
                "observations": observations,
            }

    return {
        "status": "error",
        "summary": f"已达到最大自动修复次数 {max_attempts} 次。",
        "attempts": max_attempts,
        "code": current,
        "critic": last_report,
        "observations": observations,
        "root_cause_hint": observations[-1].get("root_cause_hint", "") if observations else "",
        "safe_retry": "请尝试更简单的动画，或提供更具体的对象和分镜要求。",
    }


def repair_code(
    code: str,
    report: dict[str, Any],
    stderr: str = "",
    max_attempts: int = 4,
    fixer: Fixer | None = None,
    brief: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Synchronous compatibility helper used by tests."""
    if report.get("status") != "error":
        return {
            "status": "success",
            "summary": "代码已通过静态检查，无需自动修复。",
            "attempts": 0,
            "code": code,
            "critic": report,
        }

    current = code
    repair_fn = fixer or static_repair_once
    attempts = 0
    last_report = report

    while attempts < max_attempts:
        attempts += 1
        observation = build_repair_observation(current, last_report, stderr=stderr, attempt=attempts, brief=brief)
        patched = patch_first_repair(current, last_report)
        if patched["patches"]:
            current = patched["code"]
            patched_report = critique_code(current, brief or {})
            if patched_report["status"] != "error":
                return {
                    "status": "success",
                    "summary": "代码已通过确定性补丁完成自动修复。",
                    "attempts": attempts,
                    "code": current,
                    "critic": patched_report,
                }
            last_report = patched_report
            observation["patches"] = patched["patches"]
            observation["postPatchReport"] = patched_report
        current = repair_fn(current, observation)
        last_report = critique_code(current, brief or {})
        if last_report["status"] != "error":
            return {
                "status": "success",
                "summary": "代码已完成自动修复。",
                "attempts": attempts,
                "code": current,
                "critic": last_report,
            }

    return {
        "status": "error",
        "summary": f"已达到最大自动修复次数 {attempts} 次。",
        "attempts": attempts,
        "code": current,
        "critic": last_report,
        "root_cause_hint": stderr or "; ".join(issue["message"] for issue in last_report.get("issues", [])),
        "safe_retry": "请尝试更简单的动画，或提供更具体的对象和分镜要求。",
    }
