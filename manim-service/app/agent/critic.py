"""Static critic for generated Manim code."""

from __future__ import annotations

import ast
import re
from typing import Any


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
        "system or network module access is not allowed",
    ),
    (
        re.compile(r"\b(" + "|".join(BLOCKED_CALLS) + r")\s*\("),
        "dynamic execution or introspection is not allowed",
    ),
    (re.compile(r"__\w+__"), "double-underscore attribute access is not allowed"),
    (re.compile(r"\b(?:os|subprocess|socket|shutil|pathlib)\s*\."), "system object access is not allowed"),
)

CHINESE_RE = r"[\u4e00-\u9fff]"
MATHTEX_CHINESE_RE = re.compile(r"(?:MathTex|Tex)\s*\([^)]*" + CHINESE_RE)
LONG_DECIMAL_RE = re.compile(r"\b-?\d+\.\d{6,}\b")
MOJIBAKE_RE = re.compile(r"(?:\u934b|\u9422|\u951b|\u7efe|\u20ac|\ufffd)")


def _issue(severity: str, message: str, hint: str) -> dict[str, str]:
    return {"severity": severity, "message": message, "hint": hint}


def critique_code(code: str, brief: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return a structured static critique for generated Manim code."""
    source = code or ""
    issues: list[dict[str, str]] = []

    if "from manim import *" not in source and "from manim import" not in source:
        issues.append(_issue(
            "error",
            "Missing from manim import * import.",
            "Add a Manim import at the top of the file.",
        ))

    if "class " not in source or "def construct" not in source:
        issues.append(_issue(
            "error",
            "Missing Scene class or construct method.",
            "Return a complete runnable Manim file.",
        ))
    else:
        try:
            tree = ast.parse(source)
            scene_classes = [
                node.name
                for node in ast.walk(tree)
                if isinstance(node, ast.ClassDef)
                and any(getattr(base, "id", "") == "Scene" for base in node.bases)
            ]
            if len(scene_classes) != 1:
                issues.append(_issue(
                    "error",
                    "Generated code must expose exactly one renderable Scene class.",
                    "Keep helper classes from inheriting Scene and render only MainScene.",
                ))
            construct_methods = [
                node for node in ast.walk(tree)
                if isinstance(node, ast.FunctionDef) and node.name == "construct"
            ]
            if construct_methods and all(_construct_is_empty(method) for method in construct_methods):
                issues.append(_issue(
                    "error",
                    "Scene construct method appears empty.",
                    "Add visible Manim objects and animations.",
                ))
        except SyntaxError as exc:
            issues.append(_issue(
                "error",
                "Generated code has invalid Python syntax.",
                f"Fix syntax before rendering: {exc.msg}",
            ))

    if MATHTEX_CHINESE_RE.search(source):
        issues.append(_issue(
            "error",
            "MathTex/Tex contains Chinese characters.",
            "Move Chinese text into Text() and keep MathTex for formulas only.",
        ))

    if MOJIBAKE_RE.search(source):
        issues.append(_issue(
            "error",
            "Generated code contains mojibake Chinese text.",
            "Use valid UTF-8 Chinese strings or explicit Unicode literals.",
        ))

    if LONG_DECIMAL_RE.search(source):
        issues.append(_issue(
            "error",
            "Long decimal coordinate labels make axes unreadable.",
            "Use symbolic tick labels such as -\\pi, -\\pi/2, 0, \\pi/2, \\pi.",
        ))

    for pattern, message in DANGEROUS_PATTERNS:
        if pattern.search(source):
            issues.append(_issue(
                "error",
                message,
                "Remove system access and keep generated code sandbox-friendly.",
            ))

    if len(source.splitlines()) > 350:
        issues.append(_issue(
            "warning",
            "Generated code is very long.",
            "Simplify the animation or split it into fewer steps.",
        ))

    if source.count("Text(") + source.count("MathTex(") > 18:
        issues.append(_issue(
            "warning",
            "Many text objects may overlap.",
            "Use VGroup(...).arrange() and scale the group to fit the frame.",
        ))

    if any(issue["severity"] == "error" for issue in issues):
        status = "error"
    elif issues:
        status = "warning"
    else:
        status = "pass"

    return {
        "status": status,
        "summary": "Static critique completed.",
        "issues": issues,
        "next_actions": [issue["hint"] for issue in issues],
        "briefIntent": (brief or {}).get("intent"),
    }


def _construct_is_empty(method: ast.FunctionDef) -> bool:
    meaningful_calls = {
        "add", "play", "safe_play", "wait", "Create", "Write", "FadeIn",
        "Transform", "Circle", "Square", "Polygon", "Axes", "Dot", "Text",
        "MathTex", "Line", "Arrow", "VGroup",
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
