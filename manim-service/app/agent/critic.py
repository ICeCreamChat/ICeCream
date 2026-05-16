"""Static critic for generated Manim code."""

from __future__ import annotations

import ast
import re
from typing import Any

from .manim_knowledge import ALLOWED_SCENE_SELF_METHODS, MOJIBAKE_MARKERS, RULE_PACK_VERSION, semantic_target_from_brief


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

            for node in class_nodes:
                base_names = {_base_name(base) for base in node.bases}
                if node.name == "MainScene" and "SafeScene" in base_names and base_names.isdisjoint(RENDERABLE_SCENE_BASES):
                    main_scene_missing_scene_base = True
                if not base_names.isdisjoint(RENDERABLE_SCENE_BASES):
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
    invalid_keywords = {
        "set_x": {"aligned_edge"},
        "set_y": {"aligned_edge"},
        "set_z": {"aligned_edge"},
    }
    seen: set[tuple[str, str]] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        method = node.func.attr
        blocked = invalid_keywords.get(method)
        if not blocked:
            continue
        for keyword in node.keywords:
            if keyword.arg in blocked and (method, keyword.arg) not in seen:
                seen.add((method, keyword.arg))
                issues.append(_issue(
                    "error",
                    f"生成代码调用了不支持的 Manim 参数：{method}(..., {keyword.arg}=...)。",
                    "set_x/set_y/set_z 不支持 aligned_edge；请用 move_to、next_to、align_to，或先设置高度后移动到目标中心。",
                    "invalid_mobject_keyword",
                ))
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


def _semantic_object_issues(source: str, brief: dict[str, Any]) -> list[dict[str, str]]:
    target = semantic_target_from_brief(brief)
    if not target:
        return []

    has_circle = bool(re.search(r"\bCircle\s*\(", source))
    has_square = bool(re.search(r"\bSquare\s*\(", source))
    has_triangle = bool(re.search(r"\b(?:Triangle|Polygon)\s*\(", source)) or bool(
        re.search(r"\bRegularPolygon\s*\(\s*(?:n\s*=\s*)?3\b", source)
    )
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
        if not has_triangle:
            issues.append(_issue("error", "三角形请求没有生成三角形对象。", "使用 Triangle()、Polygon() 或 RegularPolygon(n=3) 绘制三角形主体。", "semantic_triangle_missing"))
        if has_circle and not has_triangle:
            issues.append(_issue("error", "三角形请求生成了圆形主体。", "不要用圆形满足三角形提示。", "semantic_triangle_circle_mismatch"))
    elif target == "function_graph":
        if not has_axes:
            issues.append(_issue("error", "函数图像缺少坐标系。", "使用 Axes 或 NumberPlane 绘制函数坐标系。", "function_axes_missing"))
        if not has_curve:
            issues.append(_issue("error", "函数图像缺少可见函数曲线。", "使用 axes.plot(...)、ParametricFunction 或 FunctionGraph 绘制主曲线。", "function_curve_missing"))

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
