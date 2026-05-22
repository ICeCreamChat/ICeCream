"""Static critic for generated Manim code."""

from __future__ import annotations

import ast
import re
from typing import Any

from .manim_knowledge import (
    ALLOWED_SCENE_SELF_METHODS,
    MANIM_API_COMPATIBILITY_RULES,
    MOJIBAKE_MARKERS,
    RULE_PACK_VERSION,
    contains_triangle_geometry,
    semantic_target_from_brief,
)


BLOCKED_MODULES = (
    "os", "sys", "subprocess", "socket", "pathlib", "shutil", "ctypes",
    "signal", "multiprocessing", "threading", "asyncio", "requests",
    "urllib", "http", "ftplib", "paramiko",
)

BLOCKED_CALLS = (
    "open", "exec", "eval", "compile", "__import__", "input", "breakpoint",
    "globals", "locals", "vars", "dir", "getattr", "setattr", "delattr",
)

DANGEROUS_PATTERNS = (
    (
        re.compile(r"^\s*(?:import|from)\s+(" + "|".join(BLOCKED_MODULES) + r")\b", re.MULTILINE),
        "禁止导入系统、网络或子进程相关模块。",
    ),
    (
        re.compile(r"\b(" + "|".join(BLOCKED_CALLS) + r")\s*\("),
        "禁止动态执行、反射或文件访问调用。",
    ),
    (re.compile(r"__\w+__"), "禁止访问双下划线属性。"),
    (re.compile(r"\b(?:os|subprocess|socket|shutil|pathlib)\s*\."), "禁止访问系统对象。"),
)

CHINESE_RE = r"[\u4e00-\u9fff]"
MATHTEX_CHINESE_RE = re.compile(r"(?:MathTex|Tex|SafeMathTex)\s*\([^)]*" + CHINESE_RE)
LONG_DECIMAL_RE = re.compile(r"\b-?\d+\.\d{6,}\b")
MOJIBAKE_RE = re.compile("|".join(re.escape(marker) for marker in MOJIBAKE_MARKERS))
LEGACY_API_RE = re.compile(r"\b(?:ShowCreation|TextMobject|TexMobject|number_scale_val)\b")
PSEUDO_ANIMATION_API_RE = re.compile(r"\b(?:Adding|Creating|Drawing|Showing|Animating)\s*\(")
FRAGILE_VGROUP_INDEX_RE = re.compile(r"\b(?:bars|bar_group|barGroup|columns|nodes|node_group)\.index\s*\(")
BLACK_BACKGROUND_RE = re.compile(
    r"(?:background_color|fill_color)\s*=\s*(?:BLACK|['\"]#000(?:000)?['\"])",
    re.IGNORECASE,
)
LARGE_SHIFT_RE = re.compile(r"\.shift\s*\([^)]*(?:LEFT|RIGHT|UP|DOWN)\s*\*\s*(\d+(?:\.\d+)?)", re.DOTALL)
CONNECTOR_SHIFT_RE = re.compile(
    r"(?:Arrow|DoubleArrow|Line|Vector)\s*\([^)]*\)[^\n]{0,160}\.shift\s*\([^)]*(?:LEFT|RIGHT|UP|DOWN)\s*\*\s*(\d+(?:\.\d+)?)",
    re.DOTALL,
)
UNSAFE_NEXT_TO_RE = re.compile(r"\.next_to\s*\([^)]*,\s*(?:LEFT|RIGHT|UP|DOWN)\b", re.DOTALL)
RENDERABLE_SCENE_BASES = {
    "Scene",
    "ThreeDScene",
    "MovingCameraScene",
    "ZoomedScene",
    "LinearTransformationScene",
}


def _issue(severity: str, message: str, hint: str, code: str = "") -> dict[str, str]:
    payload = {"severity": severity, "message": message, "hint": hint}
    if code:
        payload["code"] = code
    return payload


def _base_name(base: ast.expr) -> str:
    if isinstance(base, ast.Name):
        return base.id
    if isinstance(base, ast.Attribute):
        return base.attr
    if isinstance(base, ast.Subscript):
        return _base_name(base.value)
    return ""


def critique_code(code: str, brief: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return a structured static critique for generated Manim code."""
    source = code or ""
    issues: list[dict[str, str]] = []

    if "from manim import *" not in source and "from manim import" not in source:
        issues.append(_issue("error", "缺少 Manim 导入。", "在文件顶部添加 from manim import *。", "missing_manim_import"))

    if "class " not in source or "def construct" not in source:
        issues.append(_issue("error", "缺少 Scene 类或 construct 方法。", "返回完整可运行的 Manim 文件。", "missing_scene"))
    else:
        try:
            tree = ast.parse(source)
            class_nodes = [node for node in ast.walk(tree) if isinstance(node, ast.ClassDef)]
            scene_classes: list[str] = []
            main_scene_missing_scene_base = False
            safe_scene_inherits_scene = any(
                node.name == "SafeScene"
                and not {_base_name(base) for base in node.bases}.isdisjoint(RENDERABLE_SCENE_BASES)
                for node in class_nodes
            )

            for node in class_nodes:
                base_names = {_base_name(base) for base in node.bases}
                if (
                    node.name == "MainScene"
                    and "SafeScene" in base_names
                    and base_names.isdisjoint(RENDERABLE_SCENE_BASES)
                    and not safe_scene_inherits_scene
                ):
                    main_scene_missing_scene_base = True
                if node.name == "SafeScene":
                    # SafeScene is a runtime helper, not a user-renderable scene.
                    # Some LLM repairs drift to `class SafeScene(Scene)`; keep the
                    # final render contract focused on MainScene instead of
                    # failing the whole file with a second-scene false positive.
                    continue
                if not base_names.isdisjoint(RENDERABLE_SCENE_BASES) or (
                    node.name == "MainScene" and "SafeScene" in base_names and safe_scene_inherits_scene
                ):
                    scene_classes.append(node.name)

            if len(scene_classes) != 1:
                issues.append(_issue(
                    "error",
                    "生成代码必须只有一个可渲染 Scene 类。",
                    "辅助类不要继承 Scene，并保留唯一 MainScene。",
                    "scene_count",
                ))
            elif scene_classes[0] != "MainScene":
                issues.append(_issue(
                    "error",
                    "可渲染 Scene 类必须命名为 MainScene。",
                    "把唯一可渲染类改为 MainScene(SafeScene, Scene)。",
                    "scene_name",
                ))
            if main_scene_missing_scene_base:
                issues.append(_issue(
                    "error",
                    "MainScene 必须直接继承 Scene。",
                    "使用 class MainScene(SafeScene, Scene):，否则 Manim 找不到可渲染场景。",
                    "scene_contract",
                ))

            construct_methods = [
                node for node in ast.walk(tree)
                if isinstance(node, ast.FunctionDef) and node.name == "construct"
            ]
            if construct_methods and all(_construct_is_empty(method) for method in construct_methods):
                issues.append(_issue("error", "construct 方法看起来是空场景。", "添加可见对象和动画。", "empty_scene"))
            issues.extend(_unsupported_scene_method_issues(tree))
            issues.extend(_invalid_mobject_keyword_issues(tree))
            issues.extend(_invalid_angle_usage_issues(tree))
            issues.extend(_semantic_object_issues(source, brief or {}))
            issues.extend(_trig_semantic_issues(source, brief or {}))
        except SyntaxError as exc:
            issues.append(_issue("error", "生成代码存在 Python 语法错误。", f"先修复语法：{exc.msg}", "syntax_error"))

    if LEGACY_API_RE.search(source):
        issues.append(_issue(
            "error",
            "生成代码使用了旧版 Manim API。",
            "改用 Manim Community API，例如 Create、Text、MathTex，不要使用 ShowCreation/TextMobject/TexMobject/number_scale_val。",
            "legacy_api_forbidden",
        ))

    if PSEUDO_ANIMATION_API_RE.search(source):
        issues.append(_issue(
            "error",
            "生成代码使用了不存在的动画 API。",
            "只使用 Manim Community 的标准动画构造，例如 FadeIn、FadeOut、Create、Write、ReplacementTransform、Transform、GrowArrow。",
            "hallucinated_animation_api",
        ))

    if MATHTEX_CHINESE_RE.search(source):
        issues.append(_issue("error", "MathTex/Tex 中包含中文。", "中文放进 Text/SafeText，MathTex 只保留公式。", "mathtex_chinese"))

    if MOJIBAKE_RE.search(source):
        issues.append(_issue("error", "生成代码包含乱码中文。", "使用有效 UTF-8 中文字符串。", "mojibake"))

    if LONG_DECIMAL_RE.search(source):
        issues.append(_issue("error", "坐标标签出现长小数，影响可读性。", "使用 -\\pi、-\\pi/2、0、\\pi/2、\\pi 等符号刻度。", "long_decimal_ticks"))

    if FRAGILE_VGROUP_INDEX_RE.search(source):
        issues.append(_issue(
            "error",
            "生成代码使用了脆弱的 VGroup.index(...) 数据查找。",
            "柱状图或流程图请用 enumerate(zip(...)) 在创建对象时绑定数据，不要在渲染时反查 mobject 索引。",
            "fragile_vgroup_index",
        ))

    if BLACK_BACKGROUND_RE.search(source):
        issues.append(_issue("error", "生成代码设置了黑色背景或黑色外框。", "使用浅色全画布教学背景，避免黑边和黑底留白。", "black_background"))

    shift_values = [float(value) for value in LARGE_SHIFT_RE.findall(source)]
    connector_shift_values = [float(value) for value in CONNECTOR_SHIFT_RE.findall(source)]
    if any(value >= 6.0 for value in shift_values) or any(value >= 4.8 for value in connector_shift_values):
        issues.append(_issue(
            "error",
            "生成代码存在大幅位移，可能导致箭头、线段或标签出框。",
            "使用布局区域和对象端点定位，避免用大数值 shift 把对象推到画面边缘。",
            "connector_offscreen_risk",
        ))
    elif any(value >= 4.5 for value in shift_values):
        issues.append(_issue(
            "warning",
            "生成代码存在较大位移，可能导致安全边距不足。",
            "使用 VGroup(...).arrange()、move_to 安全区域或 fit_group_to_zone。",
            "unsafe_shift_risk",
        ))

    if UNSAFE_NEXT_TO_RE.search(source) and "fit_to_frame" not in source and "fit_group_to_zone" not in source:
        issues.append(_issue(
            "warning",
            "生成代码存在未受边界约束的 next_to 布局。",
            "next_to 后应整体 fit_to_frame，或改用安全布局区域。",
            "unsafe_next_to_chain",
        ))

    if source.count("self.add(") >= 6 and not any(token in source for token in ("FadeOut(", "ReplacementTransform(", "self.remove(", "self.clear(")):
        issues.append(_issue(
            "warning",
            "多个阶段持续添加对象但没有清理旧对象，可能出现堆叠或残影。",
            "每个阶段用 VGroup 管理，并在进入下一阶段前 FadeOut 或 ReplacementTransform。",
            "stage_cleanup_missing",
        ))

    for pattern, message in DANGEROUS_PATTERNS:
        if pattern.search(source):
            issues.append(_issue("error", message, "移除系统访问，保持 Manim 代码在沙箱内可运行。", "security"))

    if len(source.splitlines()) > 350:
        issues.append(_issue("warning", "生成代码过长。", "减少分镜数量或把重复对象整理成函数。", "long_code"))

    brief_kind = str(((brief or {}).get("storyboardSpec") or (brief or {}).get("spec") or {}).get("kind") or (brief or {}).get("animation_type") or "")
    brief_message = str((brief or {}).get("message") or "").lower()
    text_density_limit = 30 if brief_kind in {"flow_process", "process_flow"} or any(term in brief_message for term in ("流程", "握手", "tcp")) else 22
    scene_source = _main_scene_source(source)
    if (
        scene_source.count("Text(")
        + scene_source.count("SafeText(")
        + scene_source.count("MathTex(")
        + scene_source.count("SafeMathTex(")
        > text_density_limit
    ):
        issues.append(_issue("warning", "文字对象过多，可能发生重叠。", "使用 VGroup(...).arrange() 并分阶段显示文本。", "text_density"))

    if any(issue["severity"] == "error" for issue in issues):
        status = "error"
    elif issues:
        status = "warning"
    else:
        status = "pass"

    return {
        "status": status,
        "summary": "静态检查完成。",
        "issues": issues,
        "next_actions": [issue["hint"] for issue in issues],
        "briefIntent": (brief or {}).get("intent"),
        "rulePackVersion": RULE_PACK_VERSION,
    }


def _unsupported_scene_method_issues(tree: ast.AST) -> list[dict[str, str]]:
    """Catch hallucinations where Mobject methods are called on Scene."""
    issues: list[dict[str, str]] = []
    seen: set[str] = set()
    main_scene = next(
        (node for node in ast.walk(tree) if isinstance(node, ast.ClassDef) and node.name == "MainScene"),
        None,
    )
    if main_scene is None:
        return issues

    construct = next(
        (node for node in main_scene.body if isinstance(node, ast.FunctionDef) and node.name == "construct"),
        None,
    )
    if construct is None:
        return issues

    for node in ast.walk(construct):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        if not isinstance(node.func.value, ast.Name) or node.func.value.id != "self":
            continue
        method = node.func.attr
        if method in ALLOWED_SCENE_SELF_METHODS or method in seen:
            continue
        seen.add(method)
        issues.append(_issue(
            "error",
            f"生成代码调用了不存在的 Scene 方法：self.{method}()。",
            "不要把 Mobject 方法当作 Scene 方法调用；请改用具体对象的方法，例如 line.get_angle()、dot.get_center()、Angle(line1, line2) 或显式向量计算。",
            "unknown_scene_method",
        ))
    return issues


def _main_scene_source(source: str) -> str:
    marker = "class MainScene"
    index = source.find(marker)
    return source[index:] if index >= 0 else source


def _invalid_mobject_keyword_issues(tree: ast.AST) -> list[dict[str, str]]:
    """Catch common hallucinated keyword arguments on Manim mobject methods."""
    issues: list[dict[str, str]] = []
    blocked_constructor_keywords = MANIM_API_COMPATIBILITY_RULES["blocked_constructor_keywords"]
    blocked_method_keywords = MANIM_API_COMPATIBILITY_RULES["blocked_method_keywords"]
    setter_allowed_keywords = MANIM_API_COMPATIBILITY_RULES["setter_allowed_keywords"]
    seen: set[tuple[str, str, str]] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        call_name = _call_name(node.func)
        if not call_name:
            continue

        blocked = set(blocked_constructor_keywords.get(call_name, set()))
        if isinstance(node.func, ast.Attribute):
            blocked.update(blocked_method_keywords.get(call_name, set()))

        for keyword in node.keywords:
            if keyword.arg is None:
                continue
            if keyword.arg in blocked and ("blocked", call_name, keyword.arg) not in seen:
                seen.add(("blocked", call_name, keyword.arg))
                issues.append(_issue(
                    "error",
                    f"生成代码调用了 Manim 不支持的参数：{call_name}(..., {keyword.arg}=...)。",
                    "移除不支持的参数，并改用 move_to、next_to、align_to、set_points_as_corners 或显式坐标计算。",
                    "invalid_mobject_keyword",
                ))
                continue

            allowed = setter_allowed_keywords.get(call_name)
            if allowed is not None and keyword.arg not in allowed and ("setter", call_name, keyword.arg) not in seen:
                seen.add(("setter", call_name, keyword.arg))
                issues.append(_issue(
                    "error",
                    f"生成代码给 Manim setter 传入了不安全参数：{call_name}(..., {keyword.arg}=...)。",
                    "不要给 Mobject setter 猜测 keyword；请使用位置参数或 Manim Community 明确支持的参数。",
                    "unsafe_mobject_setter_keyword",
                ))
    issues.extend(_invalid_vgroup_child_issues(tree))
    return issues


def _invalid_vgroup_child_issues(tree: ast.AST) -> list[dict[str, str]]:
    """Catch VGroup calls that pass raw containers or primitive values."""
    issues: list[dict[str, str]] = []
    reported = False
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or _call_name(node.func) != "VGroup":
            continue
        for arg in node.args:
            if isinstance(arg, ast.Starred):
                continue
            if isinstance(arg, (ast.List, ast.Tuple, ast.Set)):
                if not reported:
                    issues.append(_issue(
                        "error",
                        "VGroup 中传入了列表或元组，可能把非 Manim 可绘制对象加入场景。",
                        "请使用 VGroup(*items) 展开列表，且列表中的每一项都必须是 Text、MathTex、Line、Dot 等 Mobject。",
                        "invalid_vgroup_child",
                    ))
                    reported = True
                continue
            if isinstance(arg, ast.Constant) and not isinstance(arg.value, (type(None), bool)):
                if not reported:
                    issues.append(_issue(
                        "error",
                        "VGroup 中混入了字符串、数字等非 Manim 可绘制对象。",
                        "请先把文字包装为 Text/SafeText，把公式包装为 MathTex/SafeMathTex，再加入 VGroup。",
                        "invalid_vgroup_child",
                    ))
                    reported = True
    return issues


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


def _angle_arg_is_safe(arg: ast.AST) -> bool:
    if isinstance(arg, (ast.Name, ast.Attribute)):
        return True
    if isinstance(arg, ast.Call):
        name = _call_name(arg.func)
        return name in {"Line", "Arrow", "Vector"}
    return False


def _invalid_angle_usage_issues(tree: ast.AST) -> list[dict[str, str]]:
    """Catch Angle(point, point) hallucinations before Manim render fails."""
    issues: list[dict[str, str]] = []
    reported = False
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if _call_name(node.func) != "Angle":
            continue
        if len(node.args) < 2:
            continue
        if _angle_arg_is_safe(node.args[0]) and _angle_arg_is_safe(node.args[1]):
            continue
        if reported:
            continue
        reported = True
        issues.append(_issue(
            "error",
            "Angle 调用传入了坐标点或表达式，而不是线段对象。",
            "先创建 Line/Arrow 对象，再使用 Angle(line1, line2)；不要把 get_corner/get_center 或向量加法结果直接传给 Angle。",
            "invalid_angle_arguments",
        ))
    return issues


def _angle_arg_name(arg: ast.AST) -> str:
    if isinstance(arg, ast.Name):
        return arg.id
    if isinstance(arg, ast.Attribute):
        return arg.attr
    return ""


def _trig_angle_ray_orientation_issues(source: str) -> list[dict[str, str]]:
    """Reject trig angle arcs built from full side lines with ambiguous orientation."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if _call_name(node.func) != "Angle" or len(node.args) < 2:
            continue
        arg_names = [_angle_arg_name(node.args[0]), _angle_arg_name(node.args[1])]
        if not all(arg_names):
            continue
        if tuple(arg_names) in {
            ("theta_adjacent_ray", "theta_hypotenuse_ray"),
            ("alpha_adjacent_ray", "alpha_hypotenuse_ray"),
        }:
            return [_issue(
                "error",
                "三角函数目标角弧方向反了。",
                "请交换 Angle 的两条辅助射线顺序，例如 Angle(theta_hypotenuse_ray, theta_adjacent_ray)，让角弧落在三角形内部。",
                "trig_angle_arc_reversed",
            )]
        uses_full_side = any(
            name in {"adjacent_side", "hypotenuse_side", "opposite_side"}
            or name.endswith("_side")
            for name in arg_names
        )
        uses_vertex_ray = all(
            "ray" in name or name.endswith("_angle_line") or name.endswith("_angle_ray")
            for name in arg_names
        )
        if uses_full_side and not uses_vertex_ray:
            return [_issue(
                "error",
                "三角函数目标角不能直接用方向不确定的边线生成角弧。",
                "请先创建从同一目标顶点出发的辅助射线，例如 theta_adjacent_ray = Line(theta_vertex, right_vertex)、theta_hypotenuse_ray = Line(theta_vertex, opposite_vertex)，再用 Angle(theta_hypotenuse_ray, theta_adjacent_ray)。",
                "trig_angle_ray_orientation_missing",
            )]
    return []


def _angle_label_has_vertex_binding(lines: list[str]) -> bool:
    joined = " ".join(lines).lower()
    return any(token in joined for token in (
        "theta_vertex",
        "alpha_vertex",
        "target_vertex",
        "angle_vertex",
        "theta_label_direction",
        "alpha_label_direction",
        "theta_bisector",
        "alpha_bisector",
        "bisector",
    ))


def _semantic_object_issues(source: str, brief: dict[str, Any]) -> list[dict[str, str]]:
    target = semantic_target_from_brief(brief)
    if not target:
        return []

    has_circle = bool(re.search(r"\bCircle\s*\(", source))
    has_square = bool(re.search(r"\bSquare\s*\(", source))
    has_triangle = contains_triangle_geometry(source)
    has_axes = "Axes(" in source or "NumberPlane(" in source
    has_curve = any(marker in source for marker in ("axes.plot", ".plot(", "ParametricFunction", "FunctionGraph", "plot_parametric_curve"))

    issues: list[dict[str, str]] = []
    if target == "circle":
        if not has_circle:
            issues.append(_issue("error", "圆形请求没有生成 Circle 对象。", "使用 Circle() 绘制圆形主体。", "semantic_circle_missing"))
        if has_triangle and not has_circle:
            issues.append(_issue("error", "圆形请求生成了三角形主体。", "不要用三角形满足圆形提示。", "semantic_circle_triangle_mismatch"))
    elif target == "square":
        if not has_square:
            issues.append(_issue("error", "正方形请求没有生成 Square 对象。", "使用 Square() 绘制正方形主体。", "semantic_square_missing"))
        if (has_circle or has_triangle) and not has_square:
            issues.append(_issue("error", "正方形请求生成了错误的几何主体。", "正方形请求应以 Square() 为主体，不要用圆形或三角形替代。", "semantic_square_mismatch"))
    elif target == "triangle":
        # For trig geometry, _trig_semantic_issues handles triangle presence via trig_triangle_missing.
        is_trig = _is_trig_semantic_request(source, brief or {})
        if not has_triangle and not is_trig:
            issues.append(_issue("error", "三角形请求没有生成三角形对象。", "使用 Triangle()、Polygon() 或 RegularPolygon(n=3) 绘制三角形主体。", "semantic_triangle_missing"))
        if has_circle and not has_triangle and not is_trig:
            issues.append(_issue("error", "三角形请求生成了圆形主体。", "不要用圆形满足三角形提示。", "semantic_triangle_circle_mismatch"))
    elif target == "function_graph":
        if not has_axes:
            issues.append(_issue("error", "函数图像缺少坐标系。", "使用 Axes 或 NumberPlane 绘制函数坐标系。", "function_axes_missing"))
        if not has_curve:
            issues.append(_issue("error", "函数图像缺少可见函数曲线。", "使用 axes.plot(...)、ParametricFunction 或 FunctionGraph 绘制主曲线。", "function_curve_missing"))

    return issues




def _assignment_base_call(node: ast.AST) -> ast.Call | None:
    expr = node
    while isinstance(expr, ast.Call) and isinstance(expr.func, ast.Attribute):
        expr = expr.func.value
    return expr if isinstance(expr, ast.Call) else None


def _literal_first_arg(call: ast.Call) -> str:
    if not call.args:
        return ""
    first = call.args[0]
    if isinstance(first, ast.Constant) and isinstance(first.value, str):
        return first.value.strip()
    return ""


def _named_text_labels(source: str) -> dict[str, str]:
    labels: dict[str, str] = {}
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return labels
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign) or not node.targets:
            continue
        call = _assignment_base_call(node.value)
        if call is None or _call_name(call.func) not in {"Text", "SafeText", "MathTex", "SafeMathTex", "Tex"}:
            continue
        text = _literal_first_arg(call)
        if not text:
            continue
        for target in node.targets:
            if isinstance(target, ast.Name):
                labels[target.id] = text
    return labels


def _variable_position_lines(source: str, var_name: str) -> list[str]:
    pattern = re.compile(rf"\b{re.escape(var_name)}\s*\.\s*(?:move_to|next_to|to_edge|to_corner|shift)\s*\(")
    lines = [line.strip() for line in source.splitlines() if pattern.search(line)]

    try:
        tree = ast.parse(source)
    except SyntaxError:
        return lines

    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(target, ast.Name) and target.id == var_name for target in node.targets):
            continue
        segment = ast.get_source_segment(source, node.value) or ""
        if re.search(r"\.(?:move_to|next_to|to_edge|to_corner|shift)\s*\(", segment):
            lines.append(segment.strip())

    return lines


def _position_is_semantically_bound(lines: list[str], semantic_tokens: tuple[str, ...]) -> bool:
    joined = " ".join(lines).lower()
    return any(token.lower() in joined for token in semantic_tokens)


def _position_is_free_floating(lines: list[str]) -> bool:
    joined = " ".join(lines)
    return bool(re.search(r"\.(?:to_edge|to_corner)\s*\(", joined)) or bool(
        re.search(r"\.move_to\s*\([^)]*(?:ORIGIN|UP|DOWN|LEFT|RIGHT|header|title|banner)", joined)
    )


def _position_line_is_free_floating(line: str) -> bool:
    return bool(re.search(r"\.(?:to_edge|to_corner)\s*\(", line)) or bool(
        re.search(r"\.move_to\s*\([^)]*(?:ORIGIN|UP|DOWN|LEFT|RIGHT|header|title|banner)", line)
    )


def _position_has_final_semantic_binding(lines: list[str], semantic_tokens: tuple[str, ...]) -> bool:
    """Treat a later side/angle binding as authoritative over earlier draft placement."""
    if not lines:
        return False
    lowered_tokens = tuple(token.lower() for token in semantic_tokens)
    last_free_index = max((index for index, line in enumerate(lines) if _position_line_is_free_floating(line)), default=-1)
    last_bound_index = max(
        (
            index
            for index, line in enumerate(lines)
            if any(token in line.lower() for token in lowered_tokens)
        ),
        default=-1,
    )
    return last_bound_index >= 0 and last_bound_index >= last_free_index


def _compact_trig_label_text(text: str) -> str:
    return re.sub(r"[\s:=：=（）()\\{}_\-]+", "", str(text).strip().lower())


def _trig_side_from_label(var_name: str, text: str) -> str | None:
    """Map visible labels like a=对边 / 对边 a / opposite_label / MathTex('c') to semantic side."""
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
    semantic_hits = {
        "a": ("对边", "opposite"),
        "b": ("邻边", "adjacent"),
        "c": ("斜边", "hypotenuse"),
    }
    for side, tokens in semantic_hits.items():
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


def _clean_text_literals_for_trig(source: str) -> list[str]:
    """Collect visible text/formula literals from MainScene for semantic checks."""
    literals: list[str] = []
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return literals
    visible_calls = {"Text", "SafeText", "MathTex", "SafeMathTex", "Tex"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _call_name(node.func) in visible_calls:
            literal = _literal_first_arg(node)
            if literal:
                literals.append(literal)
    return literals


def _normalize_trig_formula_text(text: str) -> str:
    normalized = str(text).lower()
    replacements = {
        "\\sin": "sin",
        "\\cos": "cos",
        "\\tan": "tan",
        "\\alpha": "α",
        "\\theta": "θ",
        r"\alpha": "α",
        r"\theta": "θ",
        "opposite side": "opposite",
        "adjacent side": "adjacent",
        "hypotenuse side": "hypotenuse",
        "opposite": "对边",
        "adjacent": "邻边",
        "hypotenuse": "斜边",
        "／": "/",
        "÷": "/",
        " ": "",
    }
    for src, dest in replacements.items():
        normalized = normalized.replace(src, dest)
    return normalized


def _trig_formula_segments(literals: list[str]) -> dict[str, list[str]]:
    segments: dict[str, list[str]] = {"sin": [], "cos": [], "tan": []}
    for literal in literals:
        text = _normalize_trig_formula_text(literal)
        matches = list(re.finditer(r"(sin|cos|tan)", text))
        for index, match in enumerate(matches):
            start = match.start()
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            segment = text[start:end]
            segments[match.group(1)].append(segment)
    return segments


def _segment_mentions_ratio(segment: str, numerator_terms: tuple[str, ...], denominator_terms: tuple[str, ...]) -> bool:
    if not segment:
        return False
    for numerator in numerator_terms:
        for denominator in denominator_terms:
            if f"{numerator}/{denominator}" in segment:
                return True
            frac_pattern = rf"\\frac\{{\s*{re.escape(numerator)}\s*\}}\{{\s*{re.escape(denominator)}\s*\}}"
            if re.search(frac_pattern, segment):
                return True
    return False


def _trig_formula_mapping_issue(literals: list[str]) -> str | None:
    """Return a precise formula mapping issue, if one formula segment is clearly wrong."""
    segments = _trig_formula_segments(literals)
    opposite = ("对边", "opposite", "a")
    adjacent = ("邻边", "adjacent", "b")
    hypotenuse = ("斜边", "hypotenuse", "c")

    for segment in segments["sin"]:
        if _segment_mentions_ratio(segment, adjacent, hypotenuse) or _segment_mentions_ratio(segment, opposite, adjacent):
            return "sin α 应对应 对边 / 斜边，不应对应邻边或邻边分母。"
    for segment in segments["cos"]:
        if _segment_mentions_ratio(segment, opposite, hypotenuse) or _segment_mentions_ratio(segment, adjacent, opposite):
            return "cos α 应对应 邻边 / 斜边，不应对应对边或对边分母。"
    for segment in segments["tan"]:
        if (
            _segment_mentions_ratio(segment, opposite, hypotenuse)
            or _segment_mentions_ratio(segment, adjacent, hypotenuse)
            or _segment_mentions_ratio(segment, hypotenuse, opposite + adjacent)
        ):
            return "tan α 应对应 对边 / 邻边，不应对应斜边。"
    return None


def _is_trig_semantic_request(source: str, brief: dict[str, Any]) -> bool:
    """Clean override: detect trig/triangle teaching requests with readable tokens."""
    spec = brief.get("storyboardSpec") or brief.get("spec") or {}
    parts: list[str] = [
        str(brief.get("message") or ""),
        str(brief.get("domain") or ""),
        str(brief.get("animation_type") or ""),
        str(spec.get("topic") or ""),
        str(spec.get("teaching_goal") or ""),
        str(spec.get("domain") or ""),
        str(spec.get("animation_type") or ""),
        str(spec.get("kind") or ""),
    ]
    for shot in spec.get("storyboard") or []:
        if isinstance(shot, dict):
            parts.extend([
                str(shot.get("title") or ""),
                str(shot.get("narration") or ""),
                str(shot.get("visual") or ""),
            ])
    haystack = " ".join(parts).lower()
    if any(token in haystack for token in (
        "三角函数", "直角三角", "正弦余弦正切", "正弦、余弦、正切",
        "对边", "邻边", "斜边", "sin cos tan", "sine cosine tangent",
        "trigonometric",
    )):
        return True

    main_source = _main_scene_source(source).lower()
    has_triangle_shape = contains_triangle_geometry(_main_scene_source(source))
    has_trig_formulas = all(token in main_source for token in ("sin", "cos", "tan"))
    return has_triangle_shape and has_trig_formulas


def _trig_semantic_issues(source: str, brief: dict[str, Any]) -> list[dict[str, str]]:
    """Clean override: bind trig labels/formulas to actual triangle geometry."""
    if not _is_trig_semantic_request(source, brief):
        return []

    main_source = _main_scene_source(source)
    spec = brief.get("storyboardSpec") or brief.get("spec") or {}
    labels = _named_text_labels(main_source)
    literals = _clean_text_literals_for_trig(main_source)
    lower_source = main_source.lower()
    issues: list[dict[str, str]] = []

    request_text = " ".join(
        str(part)
        for part in (
            brief.get("message") or "",
            spec.get("topic") or "",
            spec.get("teaching_goal") or "",
        )
    ).lower()
    unit_circle_requested = "单位圆" in request_text or "unit circle" in request_text
    if not unit_circle_requested and re.search(r"\bCircle\s*\(", main_source):
        issues.append(_issue(
            "error",
            "直角三角函数定义里出现了圆形/单位圆主视觉，容易替代三角形主体。",
            "除非用户明确要求单位圆，否则请删除 Circle 主体，使用直角三角形、Angle/Arc、边标和公式解释 sin/cos/tan。",
            "trig_circle_distractor",
        ))

    has_triangle = bool(re.search(r"\b(?:Triangle|Polygon)\s*\(", main_source)) or bool(
        re.search(r"\bRegularPolygon\s*\(\s*(?:n\s*=\s*)?3\b", main_source)
    )
    has_three_lines = len(re.findall(r"\bLine\s*\(", main_source)) >= 3
    if not (has_triangle or has_three_lines):
        issues.append(_issue(
            "error",
            "三角函数讲解缺少明确的三角形主体。",
            "请先用 Triangle/Polygon 或三条 Line 建立直角三角形，再绑定角标、边标和公式。",
            "trig_triangle_missing",
        ))

    has_angle_marker = bool(re.search(r"\b(?:Angle|RightAngle|Arc)\s*\(", main_source))
    if not has_angle_marker:
        issues.append(_issue(
            "error",
            "三角函数讲解缺少绑定到目标顶点的角标对象。",
            "请用 Angle(line1, line2) 或 RightAngle(...) 创建目标角，再把 α/θ 标签放到角标附近。",
            "trig_angle_marker_missing",
        ))
    else:
        issues.extend(_trig_angle_ray_orientation_issues(main_source))

    angle_vars = [
        var for var, text in labels.items()
        if text.strip() in {"α", "θ", "\\alpha", r"\alpha", "\\theta", r"\theta", "alpha", "theta"}
    ]
    formula_has_angle = any(token in main_source for token in ("α", "θ", "\\alpha", r"\alpha", "\\theta", r"\theta"))
    if formula_has_angle and not angle_vars:
        issues.append(_issue(
            "error",
            "画面里缺少独立可见的 α/θ 角标。",
            "请创建 alpha_label/theta_label，并将它 next_to 或 move_to 到 Angle/RightAngle 对象附近。",
            "trig_angle_label_missing",
        ))
    for var in angle_vars:
        lines = _variable_position_lines(main_source, var)
        has_final_binding = bool(lines) and _position_has_final_semantic_binding(
            lines,
            ("angle", "alpha_angle", "theta_angle", "right_angle", "target_angle", "vertex", "corner"),
        )
        if not has_final_binding:
            issues.append(_issue(
                "error",
                "α/θ 角标没有绑定到三角形目标顶点。",
                "请把角标放在 Angle/RightAngle 对象附近，不要使用 to_edge/to_corner 或 unrelated absolute move_to 让它漂浮。",
                "trig_angle_label_unbound",
            ))
            break
        if not _angle_label_has_vertex_binding(lines):
            issues.append(_issue(
                "error",
                "α/θ 角标没有沿目标角顶点的内角方向放置。",
                "请用 theta_vertex/alpha_vertex 加角平分方向定位，例如 theta_label.move_to(theta_vertex + LEFT * 0.45 + UP * 0.32)，不要只用 next_to(theta_angle, UP)。",
                "trig_angle_label_unbound_to_bisector",
            ))
            break

    side_label_vars: dict[str, list[str]] = {"a": [], "b": [], "c": []}
    for var, text in labels.items():
        side = _trig_side_from_label(var, text)
        if side:
            side_label_vars[side].append(var)

    side_formula_uses_abc = bool(
        re.search(r"\b(?:sin|cos|tan)\b[^'\n]*(?:a|b|c)\s*/\s*(?:a|b|c)", lower_source)
        or re.search(r"\\frac\s*\{\s*(?:a|b|c)\s*\}\s*\{\s*(?:a|b|c)\s*\}", main_source)
    )
    has_semantic_side_literals = any(term in " ".join(literals) for term in ("对边", "邻边", "斜边"))
    if side_formula_uses_abc and not all(side_label_vars.values()) and not has_semantic_side_literals:
        issues.append(_issue(
            "error",
            "三角函数公式使用了 a/b/c，但画面缺少完整边标。",
            "请为对边、邻边、斜边分别创建贴边的 a/b/c 标签，或直接使用“对边/邻边/斜边”文字说明。",
            "trig_side_label_missing",
        ))

    semantic_position_tokens = (
        "side", "line", "opposite", "adjacent", "hypotenuse",
        "opposite_side", "adjacent_side", "hypotenuse_side",
        "point_from_proportion", "get_center", "get_start", "get_end",
        "对边", "邻边", "斜边",
    )
    for side, vars_for_side in side_label_vars.items():
        for var in vars_for_side:
            lines = _variable_position_lines(main_source, var)
            if not lines or not _position_has_final_semantic_binding(lines, semantic_position_tokens):
                issues.append(_issue(
                    "error",
                    f"{side} 边标没有贴到对应边。",
                    "请把边标放到对应 Line 的中点附近，例如 side_label.move_to(side_line.point_from_proportion(0.5) + offset)。",
                    "trig_side_label_unbound",
                ))
                break

    has_all_trig = all(token in lower_source for token in ("sin", "cos", "tan"))
    has_semantic_terms = any(term in main_source for term in ("opposite", "adjacent", "hypotenuse", "对边", "邻边", "斜边"))
    if has_all_trig and not has_semantic_terms:
        issues.append(_issue(
            "error",
            "三角函数公式缺少对边、邻边、斜边的语义绑定。",
            "请明确：sin α = 对边 / 斜边，cos α = 邻边 / 斜边，tan α = 对边 / 邻边。",
            "trig_formula_semantics_missing",
        ))

    mapping_issue = _trig_formula_mapping_issue(literals)
    if mapping_issue:
        issues.append(_issue(
            "error",
            mapping_issue,
            "请重建三角函数公式与边标的对应关系，保持图中边标和公式一致。",
            "trig_formula_mapping_mismatch",
        ))

    return issues


def _construct_is_empty(method: ast.FunctionDef) -> bool:
    meaningful_calls = {
        "add", "play", "safe_play", "wait", "Create", "Write", "FadeIn",
        "Transform", "Circle", "Square", "Polygon", "Triangle", "Axes", "Dot",
        "Text", "MathTex", "Line", "Arrow", "VGroup",
    }
    body = [node for node in method.body if not isinstance(node, ast.Pass)]
    if not body:
        return True
    if len(body) == 1 and isinstance(body[0], ast.Expr):
        call = body[0].value
        if isinstance(call, ast.Call):
            name = getattr(call.func, "attr", None) or getattr(call.func, "id", "")
            return name not in meaningful_calls
    for node in ast.walk(method):
        if isinstance(node, ast.Call):
            name = getattr(node.func, "attr", None) or getattr(node.func, "id", "")
            if name in meaningful_calls and name != "wait":
                return False
    return True
