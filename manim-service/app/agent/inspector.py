"""Static quality inspector for generated Manim code."""

from __future__ import annotations

import re
from typing import Any


LONG_DECIMAL_RE = re.compile(r"\b-?\d+\.\d{6,}\b")


def _finding(severity: str, message: str, hint: str) -> dict[str, str]:
    return {"severity": severity, "message": message, "hint": hint}


def inspect_code_quality(code: str, brief: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return a lightweight quality report before rendering."""
    source = code or ""
    findings: list[dict[str, str]] = []
    text_count = len(re.findall(r"(?<![A-Za-z_])Text\s*\(", source))
    text_count += len(re.findall(r"(?<![A-Za-z_])MathTex\s*\(", source))

    if LONG_DECIMAL_RE.search(source):
        findings.append(_finding(
            "error",
            "Long decimal coordinate labels detected.",
            "Use symbolic ticks or short rounded labels.",
        ))

    if text_count > 18:
        findings.append(_finding(
            "warning",
            f"{text_count} text objects may reduce readability.",
            "Group text into staged summaries and reveal only a few labels at once.",
        ))

    if "include_numbers': True" in source or '"include_numbers": True' in source:
        findings.append(_finding(
            "warning",
            "Automatic numeric axis labels can become crowded.",
            "Disable include_numbers and add curated labels manually.",
        ))

    if (brief or {}).get("spec", {}).get("kind") == "function_graph":
        if "symbolic_ticks" not in source:
            findings.append(_finding(
                "error",
                "Function graph is missing symbolic_ticks helper.",
                "Add sparse symbolic pi tick labels.",
            ))
        if "key_points" not in source and "points =" not in source:
            findings.append(_finding(
                "warning",
                "Function graph lacks key point annotations.",
                "Mark zero, peak, and trough points.",
            ))

    if any(item["severity"] == "error" for item in findings):
        status = "error"
    elif findings:
        status = "warning"
    else:
        status = "pass"

    summary = "Quality inspection passed."
    if findings:
        summary = "; ".join(item["message"] for item in findings[:2])

    return {
        "status": status,
        "summary": summary,
        "findings": findings,
        "metrics": {
            "textObjects": text_count,
            "longDecimalLabels": len(LONG_DECIMAL_RE.findall(source)),
        },
    }
