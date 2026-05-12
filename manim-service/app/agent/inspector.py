"""Static quality inspector for generated Manim code."""

from __future__ import annotations

import re
from typing import Any


LONG_DECIMAL_RE = re.compile(r"\b-?\d+\.\d{6,}\b")
MOJIBAKE_RE = re.compile(r"(?:\u934b|\u9422|\u951b|\u7efe|\u20ac|\ufffd)")


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

    if MOJIBAKE_RE.search(source):
        findings.append(_finding(
            "error",
            "Mojibake Chinese text detected.",
            "Use valid UTF-8 strings in generated code and tests.",
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

    spec = (brief or {}).get("storyboardSpec") or (brief or {}).get("spec", {})
    if spec.get("kind") == "geometry_circle" or spec.get("animation_type") == "geometry_circle":
        if "Circle(" not in source:
            findings.append(_finding(
                "error",
                "Circle request did not generate a Circle object.",
                "Preserve the requested object semantics with Circle(), radius, and diameter labels.",
            ))
        if "Polygon(" in source or "triangle" in source.lower():
            findings.append(_finding(
                "error",
                "Circle request generated triangle geometry.",
                "Do not satisfy a circle prompt with triangle geometry.",
            ))

    if spec.get("version") in {"v3", "v4"}:
        for helper_name in ("make_header", "make_step_banner"):
            if f"def {helper_name}" not in source:
                findings.append(_finding(
                    "error",
                    f"Animation is missing layout helper {helper_name}.",
                    "Use the generic scene runtime helpers.",
                ))

    if spec.get("kind") == "function_graph" and spec.get("version") == "v3":
        has_top_header = ".to_edge(UP" in source
        has_corner_step = ".to_corner(UL" in source and "step" in source
        if has_top_header and has_corner_step:
            findings.append(_finding(
                "error",
                "Function graph header and step label overlap risk detected.",
                "Use separate header and step banner layout zones.",
            ))
        required_helpers = {
            "make_header": "Function graph is missing a bounded header layout helper.",
            "make_step_banner": "Function graph is missing a dedicated step banner helper.",
            "place_graph_area": "Function graph is missing an isolated graph area helper.",
            "assert_layout_zones": "Function graph is missing explicit layout zone placement.",
        }
        for helper_name, message in required_helpers.items():
            if f"def {helper_name}" not in source:
                findings.append(_finding(
                    "error",
                    message,
                    "Use generic layout helpers and keep graph, header, step text, and summary in separate zones.",
                ))
        if "scale_to_fit_width" not in source:
            findings.append(_finding(
                "error",
                "Function graph title width is not constrained.",
                "Clamp or scale long titles before placing the header.",
            ))
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
    elif spec.get("kind") == "function_graph" or spec.get("animation_type") == "function_graph":
        if "\\pi" not in source and "PI" not in source:
            findings.append(_finding(
                "warning",
                "Function graph does not appear to use symbolic pi markers.",
                "Use symbolic labels such as -\\pi, 0, and \\pi for trigonometric graphs.",
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
