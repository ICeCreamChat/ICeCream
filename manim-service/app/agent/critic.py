"""Static critic for generated Manim code."""

from __future__ import annotations

import re
from typing import Any


DANGEROUS_PATTERNS = (
    (re.compile(r"^\s*import\s+os\b", re.MULTILINE), "system access via os is not allowed"),
    (re.compile(r"^\s*import\s+subprocess\b", re.MULTILINE), "system access via subprocess is not allowed"),
    (re.compile(r"\b(eval|exec|__import__)\s*\("), "dynamic execution is not allowed"),
    (re.compile(r"\bopen\s*\("), "file access is not allowed"),
)

CHINESE_RE = r"[\u4e00-\u9fff]"
MATHTEX_CHINESE_RE = re.compile(r"(?:MathTex|Tex)\s*\([^)]*" + CHINESE_RE)


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

    if MATHTEX_CHINESE_RE.search(source):
        issues.append(_issue(
            "error",
            "MathTex/Tex contains Chinese characters.",
            "Move Chinese text into Text() and keep MathTex for formulas only.",
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

