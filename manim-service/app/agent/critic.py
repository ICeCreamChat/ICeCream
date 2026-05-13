"""Static critic for generated Manim code."""

from __future__ import annotations

import ast
import re
from typing import Any

from .manim_knowledge import ALLOWED_SCENE_SELF_METHODS


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
MOJIBAKE_RE = re.compile(r"(?:\u934b|\u9422|\u951b|\u7efe|\u20ac|\ufffd)")
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
        except SyntaxError as exc:
            issues.append(_issue("error", "生成代码存在 Python 语法错误。", f"先修复语法：{exc.msg}", "syntax_error"))

    if MATHTEX_CHINESE_RE.search(source):
        issues.append(_issue("error", "MathTex/Tex 中包含中文。", "中文放进 Text/SafeText，MathTex 只保留公式。", "mathtex_chinese"))

    if MOJIBAKE_RE.search(source):
        issues.append(_issue("error", "生成代码包含乱码中文。", "使用有效 UTF-8 中文字符串。", "mojibake"))

    if LONG_DECIMAL_RE.search(source):
        issues.append(_issue("error", "坐标标签出现长小数，影响可读性。", "使用 -\\pi、-\\pi/2、0、\\pi/2、\\pi 等符号刻度。", "long_decimal_ticks"))

    for pattern, message in DANGEROUS_PATTERNS:
        if pattern.search(source):
            issues.append(_issue("error", message, "移除系统访问，保持 Manim 代码在沙箱内可运行。", "security"))

    if len(source.splitlines()) > 350:
        issues.append(_issue("warning", "生成代码过长。", "减少分镜数量或把重复对象整理成函数。", "long_code"))

    if source.count("Text(") + source.count("SafeText(") + source.count("MathTex(") + source.count("SafeMathTex(") > 22:
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
